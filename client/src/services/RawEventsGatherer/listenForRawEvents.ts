// src/services/RawEventsGatherer/listenForRawEvents.ts
import { ContractEventPayload, WebSocketProvider, Contract, keccak256, toUtf8Bytes, getBytes, concat } from 'ethers'
import type { Log } from '@ethersproject/abstract-provider'
import { CAW_ACTIONS_ADDRESS } from '../../abi/addresses'
import { makeJsonRpcProvider, makeWebSocketProvider, getL2HttpRpcUrl, waitForRateLimit } from '../../utils/rpcProvider'
import delay from '../../tools/delay'
import SmlTxt from 'smltxt'
import { unpackActions } from '../../utils/packActions'

// smltxt singleton — events arrive with `bytes text` (compressed) but the
// rest of the pipeline (ActionProcessor, hashtag/mention indexing, Caw.content
// storage) expects plaintext. Decompress here so downstream code is unchanged.
let _smlTxt: SmlTxt | undefined
function decompressEventText(hex: unknown): string {
  if (typeof hex !== 'string' || !hex || hex === '0x') return ''
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2 !== 0) return ''
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  if (!_smlTxt) _smlTxt = SmlTxt.fromPkg()
  try { return _smlTxt.decompress(bytes) } catch { return '' }
}

export type RawEventInput = {
  chainId: number
  blockNumber: number
  logIndex: number
  transactionHash: string
  parentHash: string
  data: any
  topics: string[]
  contractAddress: string
}

const CONTRACT_ABI = [
  'event ActionsProcessed(bytes packedActions)'
]


/**
 * listenForRawEvents
 * @description stream historical + live ActionsProcessed logs, compute parentHash chain
 */
export default async function listenForRawEvents(
  config: {
    rpcUrl: string
    contractAddress: string
    chainId: number
    /** Scope this indexer to one client; actions for other clients are dropped. */
    clientId: number
    startBlock?: number // Minimum block to start scanning from (avoids old contract events)
    rawEventsProvider: {
      getLastProcessedEvent(): Promise<{
        blockNumber: number
        logIndex: number
        parentHash: string
      } | null>
      storeEvent(e: RawEventInput): Promise<void>
      /**
       * Optional bulk variant. When present, processEvents uses this for the
       * N packed actions inside a single on-chain ActionsProcessed event —
       * one INSERT instead of N. Falls back to storeEvent when absent.
       */
      storeBatch?(events: RawEventInput[]): Promise<void>
    }
    /** Optional callback to signal liveness — called at the end of each successful poll */
    onTick?: () => void
  }
): Promise<{ stop(): void }> {
  let wsProvider: WebSocketProvider | null = null
  let wsContract: Contract | null = null
  let isReconnecting = false
  let isStopped = false

  // HTTP provider for reliable polling (WebSocket can die silently)
  const httpRpcUrl = getL2HttpRpcUrl(config.rpcUrl)
  const httpProvider = makeJsonRpcProvider(httpRpcUrl, config.chainId)
  const httpContract = new Contract(CAW_ACTIONS_ADDRESS, CONTRACT_ABI, httpProvider)

  const last = await config.rawEventsProvider.getLastProcessedEvent()
  // On fresh DB: use configured startBlock, or current block (never scan from 0)
  let startBlock: number
  if (last) {
    startBlock = last.blockNumber
  } else if (config.startBlock !== undefined) {
    startBlock = config.startBlock
    console.log(`[RawEventsGatherer] Fresh DB — starting from configured startBlock ${startBlock}`)
  } else {
    startBlock = await httpProvider.getBlockNumber()
    console.log(`[RawEventsGatherer] Fresh DB, no startBlock configured — starting from current block ${startBlock}`)
  }
  let lastHash = last?.parentHash ?? 'genesis'

  function hashNext(prev: string, action: any): string {
    // JSON stringify with bigint→string replacer
    const json = JSON.stringify(action, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v
    )
    // turn previous hash hex → bytes, and action JSON → bytes
    // if prev is hex, decode it; otherwise treat as text
    const prevBytes = prev.match(/^0x[0-9a-fA-F]+$/)
      ? getBytes(prev)
      : toUtf8Bytes(prev)
    const input = concat([ prevBytes, toUtf8Bytes(json) ])
    // pure‑JS keccak256 → hex string
    return keccak256(input)
  }

  // Process events from a Log array (used by both historical fetch and polling).
  //
  // Each on-chain ActionsProcessed event carries N packed actions. We unpack
  // them, compute the parentHash chain SEQUENTIALLY (each depends on the prior
  // one), then hand the full batch to the provider. When the provider exposes
  // storeBatch, a single INSERT replaces what used to be N sequential UPSERTs
  // per event. Falls back to one-by-one storeEvent if no batch method.
  async function processEvents(events: Log[], contract: Contract) {
    for (const ev of events) {
      const rawData = ev.data ?? '0x'
      const decoded = contract.interface.decodeEventLog(
        'ActionsProcessed',
        rawData,
        ev.topics
      )
      // Decode packed bytes from ActionsProcessed(bytes packedActions)
      const packedHex = decoded.packedActions as string
      const packedBuf = new Uint8Array((packedHex.startsWith('0x') ? packedHex.slice(2) : packedHex).match(/.{2}/g)!.map(b => parseInt(b, 16)))
      const actions = unpackActions(packedBuf)

      // Build the full batch in one pass. parentHash must chain sequentially,
      // but the inserts themselves don't need to.
      const batch: RawEventInput[] = []
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i]
        // Skip actions for other clients — this instance is scoped to
        // config.clientId. Do this BEFORE hashNext so the parentHash chain
        // contains only actions we actually store. Mixing in other clients'
        // actions would make the chain unverifiable on reindex.
        if (Number(a.clientId) !== config.clientId) continue
        const action = {
          actionType:      a.actionType,
          senderId:        a.senderId,
          receiverId:      a.receiverId,
          receiverCawonce: a.receiverCawonce,
          clientId:        a.clientId,
          cawonce:         a.cawonce,
          recipients:      a.recipients,
          amounts:         a.amounts,
          text:            decompressEventText(a.text)
        }
        // Offset logIndex by action position within the batch so each action
        // gets a unique (blockNumber, logIndex, transactionHash) key.
        const logIndex = (ev.logIndex ?? 0) + i
        lastHash = hashNext(lastHash, action)
        batch.push({
          chainId:         config.chainId,
          blockNumber:     ev.blockNumber,
          logIndex,
          transactionHash: ev.transactionHash,
          parentHash:      lastHash,
          data:            action,
          topics:          ev.topics,
          contractAddress: ev.address
        })
      }

      if (config.rawEventsProvider.storeBatch) {
        await config.rawEventsProvider.storeBatch(batch)
      } else {
        for (const entry of batch) {
          await config.rawEventsProvider.storeEvent(entry)
        }
      }
    }
  }

  // Fetch historical events using HTTP provider (more reliable)
  let past: Log[]
  while (true) {
    try {
      const raw = await httpContract.queryFilter(
        httpContract.filters.ActionsProcessed(),
        startBlock
      )
      past = raw as unknown as Log[]
      break
    } catch (err) {
      console.error('[RawEventsGatherer] Error fetching past events, retrying in 5s', err)
      await delay(5000)
    }
  }

  await processEvents(past, httpContract)

  // Setup WebSocket for real-time events
  async function setupWebSocket() {
    if (isStopped) return

    try {
      console.log('[RawEventsGatherer] Setting up WebSocket connection...')
      wsProvider = makeWebSocketProvider(config.rpcUrl, config.chainId)
      wsContract = new Contract(CAW_ACTIONS_ADDRESS, CONTRACT_ABI, wsProvider)

      wsContract.on('ActionsProcessed', async (packedHex: string, ev: ContractEventPayload) => {
        console.log("[RawEventsGatherer] Raw event received via WebSocket", ev)
        try {
          const packedBuf = new Uint8Array((packedHex.startsWith('0x') ? packedHex.slice(2) : packedHex).match(/.{2}/g)!.map(b => parseInt(b, 16)))
          const wsActions = unpackActions(packedBuf)

          // Build batch, then either bulk-store or fall back to per-row.
          // Same pattern as processEvents() — parentHash chain stays sequential.
          const batch: RawEventInput[] = []
          for (let i = 0; i < wsActions.length; i++) {
            const a = wsActions[i]
            // Scope to our client — see processEvents() for rationale.
            if (Number(a.clientId) !== config.clientId) continue
            const action = {
              actionType:      a.actionType,
              senderId:        a.senderId,
              receiverId:      a.receiverId,
              receiverCawonce: a.receiverCawonce,
              clientId:        a.clientId,
              cawonce:         a.cawonce,
              recipients:      a.recipients,
              amounts:         a.amounts,
              text:            decompressEventText(a.text)
            }
            const logIndex = (ev.log.index ?? 0) + i
            lastHash = hashNext(lastHash, action)
            batch.push({
              chainId:         config.chainId,
              blockNumber:     ev.log.blockNumber,
              logIndex,
              transactionHash: ev.log.transactionHash,
              parentHash:      lastHash,
              data:            action,
              topics:          [ ...ev.log.topics ] ,
              contractAddress: ev.log.address
            })
          }

          if (config.rawEventsProvider.storeBatch) {
            await config.rawEventsProvider.storeBatch(batch)
          } else {
            for (const entry of batch) {
              await config.rawEventsProvider.storeEvent(entry)
            }
          }
        } catch (err) {
          console.error("[RawEventsGatherer] FAILED to process raw event from WebSocket", err)
        }
      })

      // Monitor WebSocket connection health.
      // Leading semicolons guard against ASI — without them the parser reads
      // `})` + `(wsProvider...` as a function call on the previous .on() return
      // value, which in ethers v6 is Promise<Contract> (not callable).
      ;(wsProvider.websocket as any).on('close', () => {
        if (!isStopped) {
          scheduleReconnect()
        }
      })

      ;(wsProvider.websocket as any).on('error', (err: any) => {
        // Suppress noisy stack traces for common RPC errors (rate limit, auth)
        const msg = err?.message || String(err)
        if (msg.includes('401') || msg.includes('429') || msg.includes('Too Many')) {
          if (wsConsecutiveErrors === 0) {
            console.warn(`[RawEventsGatherer] WebSocket error: ${msg.includes('401') ? 'Auth failed (401)' : 'Rate limited (429)'} — will retry`)
          }
        } else if (wsConsecutiveErrors === 0) {
          console.error(`[RawEventsGatherer] WebSocket error: ${msg.slice(0, 150)}`)
        }
        wsConsecutiveErrors++
        scheduleReconnect()
      })

      wsConsecutiveErrors = 0
      console.log('[RawEventsGatherer] WebSocket connection established')
    } catch (err: any) {
      const msg = err?.message || String(err)
      if (wsConsecutiveErrors === 0) {
        console.error(`[RawEventsGatherer] Failed to setup WebSocket: ${msg.slice(0, 150)}`)
      }
      wsConsecutiveErrors++
      scheduleReconnect()
    }
  }

  let wsConsecutiveErrors = 0

  function scheduleReconnect() {
    if (isReconnecting || isStopped) return
    isReconnecting = true

    // Clean up old connection
    if (wsContract) {
      try { wsContract.removeAllListeners() } catch {}
    }
    if (wsProvider) {
      try {
        const ws = (wsProvider as any).websocket || (wsProvider as any)._websocket
        if (ws && (ws.readyState === 0 /* CONNECTING */ || ws.readyState === 3 /* CLOSED */)) {
          // Don't call destroy if the WebSocket never connected or is already closed —
          // ethers' destroy() calls ws.close() which throws "WebSocket was closed before
          // the connection was established" as an uncaught exception.
          wsProvider = null
        } else {
          (wsProvider as any).destroy?.()
        }
      } catch {}
    }
    wsProvider = null
    wsContract = null

    // Back off more aggressively after repeated failures
    const delay = Math.min(5000 * Math.pow(1.5, Math.min(wsConsecutiveErrors, 8)), 60000)
    if (wsConsecutiveErrors > 0 && wsConsecutiveErrors % 10 === 0) {
      console.log(`[RawEventsGatherer] WebSocket reconnect attempt ${wsConsecutiveErrors}, next retry in ${Math.round(delay / 1000)}s`)
    }

    setTimeout(async () => {
      isReconnecting = false
      if (!isStopped) {
        await waitForRateLimit()
        await setupWebSocket()
      }
    }, delay)
  }

  // WebSocket is DISABLED by default. Infura (and most public RPCs) rate-limit
  // `eth_subscribe` on a per-connection-attempt basis — when reconnects storm,
  // every attempt 429s and throws unhandled rejections. The per-second burst
  // from 3-5 near-simultaneous subscribe retries is the single biggest source
  // of rate-limit pressure in this stack. HTTP polling is deterministic,
  // bounded, and uses a quota we already have plenty of. Flip ENABLE_RAW_EVENTS_WS=1
  // to re-enable if you ever need sub-5s event latency.
  if (process.env.ENABLE_RAW_EVENTS_WS === '1') {
    await setupWebSocket()
  } else {
    console.log('[RawEventsGatherer] WebSocket disabled — HTTP polling only (set ENABLE_RAW_EVENTS_WS=1 to re-enable)')
  }

  // Track last synced block for polling - start from the latest processed event
  let lastSyncedBlock = past.length > 0 ? past[past.length - 1].blockNumber : startBlock

  // Cap each poll's range so a service waking up far behind can't request
  // millions of logs in one call. Steady state stays well under this.
  const MAX_POLL_BLOCKS = 10_000
  const POLL_INTERVAL_MS = Number(process.env.RAW_EVENTS_POLL_MS) || 5000

  // setTimeout chain (NOT setInterval) so slow polls don't pile up. With
  // setInterval, a 20s-slow iteration during a rate-limit window would let
  // 4 parallel polls fire on top of each other, each making fresh RPC calls
  // and compounding the throttle pressure.
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleNextPoll = () => {
    if (isStopped) return
    pollTimer = setTimeout(poll, POLL_INTERVAL_MS)
  }
  async function poll() {
    if (isStopped) return
    try {
      const currentBlock = await httpProvider.getBlockNumber()
      if (currentBlock > lastSyncedBlock) {
        const toBlock = Math.min(currentBlock, lastSyncedBlock + MAX_POLL_BLOCKS)
        if (toBlock < currentBlock) {
          console.log(`[RawEventsGatherer] Catching up: polling ${lastSyncedBlock + 1}..${toBlock} (behind by ${currentBlock - toBlock} blocks)`)
        } else {
          console.log(`[RawEventsGatherer] Polling for events ${lastSyncedBlock + 1}..${toBlock}`)
        }
        const events = await httpContract.queryFilter(
          httpContract.filters.ActionsProcessed(),
          lastSyncedBlock + 1,
          toBlock
        ) as unknown as Log[]

        if (events.length > 0) {
          await processEvents(events, httpContract)
          console.log(`[RawEventsGatherer] Polled ${events.length} event(s)`)
        }
        lastSyncedBlock = toBlock
      }
      config.onTick?.()
    } catch (err) {
      console.error('[RawEventsGatherer] Polling error:', err)
      // Don't update lastSyncedBlock on error, will retry on next schedule
    } finally {
      scheduleNextPoll()
    }
  }
  poll() // kick off the first iteration immediately

  return {
    stop() {
      isStopped = true
      if (pollTimer) clearTimeout(pollTimer)
      if (wsContract) {
        try { wsContract.removeAllListeners() } catch {}
      }
      if (wsProvider) {
        try { (wsProvider as any).destroy?.() } catch {}
      }
    }
  }
}


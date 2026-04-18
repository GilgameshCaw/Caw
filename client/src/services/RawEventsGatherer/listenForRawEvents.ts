// src/services/RawEventsGatherer/listenForRawEvents.ts
import { ContractEventPayload, WebSocketProvider, Contract, keccak256, toUtf8Bytes, getBytes, concat } from 'ethers'
import type { Log } from '@ethersproject/abstract-provider'
import { CAW_ACTIONS_ADDRESS } from '../../abi/addresses'
import { makeJsonRpcProvider, makeWebSocketProvider } from '../../utils/rpcProvider'
import delay from '../../tools/delay'
import SmlTxt from 'smltxt'

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
  'event ActionsProcessed(' +
  'tuple(' +
    'uint8 actionType,' +
    'uint32 senderId,' +
    'uint32 receiverId,' +
    'uint32 receiverCawonce,' +
    'uint32 clientId,' +
    'uint32 cawonce,' +
    'uint32[] recipients,' +
    'uint64[] amounts,' +
    'bytes text' +
  ')[] actions' +
  ')'
]

/**
 * Convert WebSocket URL to HTTP URL for fallback polling
 * Handles Infura and other providers that have /ws in the WebSocket path
 */
function wsToHttp(wsUrl: string): string {
  return wsUrl
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://')
    .replace(/\/ws\//, '/')  // Remove /ws/ from path (Infura format)
}

/**
 * listenForRawEvents
 * @description stream historical + live ActionsProcessed logs, compute parentHash chain
 */
export default async function listenForRawEvents(
  config: {
    rpcUrl: string
    contractAddress: string
    chainId: number
    startBlock?: number // Minimum block to start scanning from (avoids old contract events)
    rawEventsProvider: {
      getLastProcessedEvent(): Promise<{
        blockNumber: number
        logIndex: number
        parentHash: string
      } | null>
      storeEvent(e: RawEventInput): Promise<void>
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
  const httpRpcUrl = wsToHttp(config.rpcUrl)
  const httpProvider = makeJsonRpcProvider(httpRpcUrl)
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

  // Process events from a Log array (used by both historical fetch and polling)
  async function processEvents(events: Log[], contract: Contract) {
    for (const ev of events) {
      const rawData = ev.data ?? '0x'
      const decoded = contract.interface.decodeEventLog(
        'ActionsProcessed',
        rawData,
        ev.topics
      )
      console.log("Will store: ", ev)
      const actions = decoded.actions as any[]
      for (let i = 0; i < actions.length; i++) {
        const tuple = actions[i]
        const action = {
          actionType:      Number(tuple[0]),
          senderId:        Number(tuple[1]),
          receiverId:      Number(tuple[2]),
          receiverCawonce: Number(tuple[3]),
          clientId:        Number(tuple[4]),
          cawonce:         Number(tuple[5]),
          recipients:      tuple[6],
          amounts:         tuple[7],
          text:            decompressEventText(tuple[8])
        }
        // Offset logIndex by action position within the batch so each action
        // gets a unique (blockNumber, logIndex, transactionHash) key
        const logIndex = (ev.logIndex ?? 0) + i
        lastHash = hashNext(lastHash, action)
        await config.rawEventsProvider.storeEvent({
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
      wsProvider = makeWebSocketProvider(config.rpcUrl)
      wsContract = new Contract(CAW_ACTIONS_ADDRESS, CONTRACT_ABI, wsProvider)

      wsContract.on('ActionsProcessed', async (rawActions: any[], ev: ContractEventPayload) => {
        console.log("[RawEventsGatherer] Raw event received via WebSocket", rawActions, ev)
        try {
          for (let i = 0; i < rawActions.length; i++) {
            const tuple = rawActions[i]
            const action = {
              actionType:      Number(tuple[0]),
              senderId:        Number(tuple[1]),
              receiverId:      Number(tuple[2]),
              receiverCawonce: Number(tuple[3]),
              clientId:        Number(tuple[4]),
              cawonce:         Number(tuple[5]),
              recipients:      tuple[6],
              amounts:         tuple[7],
              text:            decompressEventText(tuple[8])
            }
            // Offset logIndex by action position within the batch
            const logIndex = (ev.log.index ?? 0) + i
            lastHash = hashNext(lastHash, action)
            await config.rawEventsProvider.storeEvent({
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
        } catch (err) {
          console.error("[RawEventsGatherer] FAILED to process raw event from WebSocket", err)
        }
      })

      // Monitor WebSocket connection health
      (wsProvider.websocket as any).on('close', () => {
        if (!isStopped) {
          scheduleReconnect()
        }
      })

      (wsProvider.websocket as any).on('error', (err: any) => {
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
        await setupWebSocket()
      }
    }, delay)
  }

  // Initial WebSocket setup
  await setupWebSocket()

  // Track last synced block for polling - start from the latest processed event
  let lastSyncedBlock = past.length > 0 ? past[past.length - 1].blockNumber : startBlock

  // Periodic polling using HTTP provider (more reliable than WebSocket)
  const pollInterval = setInterval(async () => {
    if (isStopped) return

    try {
      const currentBlock = await httpProvider.getBlockNumber()
      if (currentBlock > lastSyncedBlock) {
        console.log(`[RawEventsGatherer] Polling for missed events from block ${lastSyncedBlock + 1} to ${currentBlock}`)
        const events = await httpContract.queryFilter(
          httpContract.filters.ActionsProcessed(),
          lastSyncedBlock + 1,
          currentBlock
        ) as unknown as Log[]

        if (events.length > 0) {
          await processEvents(events, httpContract)
          console.log(`[RawEventsGatherer] Polled ${events.length} missed event(s)`)
        }
        lastSyncedBlock = currentBlock
      }
      // Heartbeat: successful poll (even if there were no new events)
      config.onTick?.()
    } catch (err) {
      console.error('[RawEventsGatherer] Polling error:', err)
      // Don't update lastSyncedBlock on error, will retry next interval
    }
  }, 15000) // Poll every 15 seconds (was 30s, now faster for better responsiveness)

  return {
    stop() {
      isStopped = true
      clearInterval(pollInterval)
      if (wsContract) {
        try { wsContract.removeAllListeners() } catch {}
      }
      if (wsProvider) {
        try { (wsProvider as any).destroy?.() } catch {}
      }
    }
  }
}


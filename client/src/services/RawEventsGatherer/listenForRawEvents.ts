// src/services/RawEventsGatherer/listenForRawEvents.ts
import { ContractEventPayload, WebSocketProvider, Contract, Interface, keccak256, toUtf8Bytes, getBytes, concat } from 'ethers'
import type { Log } from '@ethersproject/abstract-provider'
import { CAW_ACTIONS_ADDRESS, CAW_ACTIONS_ERC1271_ADDRESS } from '../../abi/addresses'
import { makeFallbackJsonRpcProvider, makeVerifiedFallbackJsonRpcProvider, makeWebSocketProvider, getL2HttpRpcUrls, getL2WsSecret, waitForRateLimit, redactRpcUrl } from '../../utils/rpcProvider'
import { scanLogsForward } from '../../utils/chunkedLogs'
import delay from '../../tools/delay'
import SmlTxt from 'smltxt'
import { unpackActions } from '../../utils/packActions'
import { span } from '../../utils/trace'
import { recordIndexerProgress } from '../../utils/indexerHealth'

/**
 * Decide the block range for one poll.
 *
 * `headMargin` keeps the request below the head that getBlockNumber
 * reported: under a FallbackProvider (quorum 1) that call and the
 * following getLogs can be served by different upstreams, and the one
 * answering getLogs may be a block behind — which the provider rejects
 * as -32602 "block range extends beyond current head block".
 *
 * Returns null when there is nothing to fetch. The margin has to apply
 * to that decision as well as to `toBlock`: comparing lastSyncedBlock
 * against the unadjusted head would let `from > to` through whenever the
 * cursor sits inside the margin.
 */
export function computePollRange(
  currentBlock: number,
  lastSyncedBlock: number,
  headMargin: number,
  maxPollBlocks: number,
): { head: number; toBlock: number } | null {
  const head = currentBlock - headMargin
  if (head <= lastSyncedBlock) return null
  return { head, toBlock: Math.min(head, lastSyncedBlock + maxPollBlocks) }
}

// Calldata-decode interface. ActionsProcessed events now carry only
// (networkId, validatorId, actionCount, batchHash) — the actual packedActions
// bytes live in the originating tx's calldata. We fetch tx.input via
// eth_getTransactionByHash and decode the function args.
//
// Both CawActions (sig path) and CawActionsERC1271 (ERC-1271 path) share the
// same packedActions wire format inside, so we parse both here. The outer
// wrapper differs: the ERC-1271 variant carries bytes[] sigs + bytes32[] rs
// instead of a single packed bytes sigs.
const PROCESS_ACTIONS_IFACE = new Interface([
  'function processActions(uint32 validatorId, bytes packedActions, bytes sigs, uint256 withdrawFee, uint256 withdrawLzTokenAmount) payable',
  'function safeProcessActions(uint32 validatorId, bytes packedActions, bytes sigs, uint256 withdrawFee, uint256 withdrawLzTokenAmount) payable returns (uint256 successCount, bytes[] rejections)',
  'function processActionsERC1271(uint32 validatorId, bytes packedActions, bytes[] sigs, bytes32[] rs, uint256 withdrawFee, uint256 withdrawLzTokenAmount) payable',
])

// safeProcessActions emits one ActionRejected per rejected action, in the
// SAME tx receipt as the ActionsProcessed commitment. This is the ground
// truth for which (senderId, cawonce) pairs in packedActions were rejected
// by the contract (bad sig, senderId=0/ownerOf revert, cawonce race,
// insufficient balance, etc.) and therefore never applied to chain state —
// see CawActions.sol safeProcessActions/​_safeProcessOneGroup. Neither
// topic is indexed, so senderId/cawonce/reason all live in log.data.
const ACTION_REJECTED_IFACE = new Interface([
  'event ActionRejected(uint32 senderId, uint32 cawonce, bytes reason)',
])
const ACTION_REJECTED_TOPIC = ACTION_REJECTED_IFACE.getEvent('ActionRejected')!.topicHash


// Cache packedActions per txHash so multiple events from the same tx don't
// re-fetch (rare with the new event since one tx → one event, but cheap to
// keep and protects against future safeProcessActions partial-success cases).
const txDataCache = new Map<string, string>()
const TX_CACHE_MAX = 200

// Cache the rejected-(senderId,cawonce) set per txHash, mirroring txDataCache.
// A tx can contain many rejected actions from multiple sig groups; we only
// want to fetch+parse the receipt once per tx even though processEvents/the
// WS handlers may see multiple ActionsProcessed-derived batches reference it
// (e.g. sig path + ERC-1271 sibling emitting for the same underlying tx is
// not expected, but historical + live paths can both touch the same tx during
// backfill overlap).
const rejectedSetCache = new Map<string, Set<string>>()
const REJECTED_CACHE_MAX = 200

function rejectedKey(senderId: number | bigint, cawonce: number | bigint): string {
  return `${senderId}:${cawonce}`
}

// Fetch the tx receipt and extract the set of rejected (senderId, cawonce)
// keys from its ActionRejected logs. Distinguishes "receipt fetch/parse
// failed" (caller must treat this like fetch_failed — abort and retry,
// never guess) from "no rejections" (empty set is a perfectly normal,
// successful result).
type FetchRejectedSetResult =
  | { kind: 'ok'; rejected: Set<string> }
  | { kind: 'fetch_failed' }

async function fetchRejectedSetFromTx(
  provider: { getTransactionReceipt: (h: string) => Promise<{ logs: ReadonlyArray<{ topics: ReadonlyArray<string>; data: string }> } | null> },
  txHash: string,
): Promise<FetchRejectedSetResult> {
  const hit = rejectedSetCache.get(txHash)
  if (hit !== undefined) return { kind: 'ok', rejected: hit }
  let receipt: { logs: ReadonlyArray<{ topics: ReadonlyArray<string>; data: string }> } | null
  try {
    receipt = await provider.getTransactionReceipt(txHash)
  } catch {
    return { kind: 'fetch_failed' }
  }
  if (!receipt) return { kind: 'fetch_failed' }
  const rejected = new Set<string>()
  try {
    for (const log of receipt.logs) {
      if (!log.topics || log.topics[0] !== ACTION_REJECTED_TOPIC) continue
      const parsed = ACTION_REJECTED_IFACE.parseLog({ topics: log.topics as string[], data: log.data })
      if (!parsed) continue
      rejected.add(rejectedKey(parsed.args.senderId, parsed.args.cawonce))
    }
  } catch {
    // Malformed log data for what looked like an ActionRejected topic --
    // can't trust a partial rejection set (could under-count and let a
    // rejected action through as if it succeeded). Treat as fetch failure.
    return { kind: 'fetch_failed' }
  }
  if (rejectedSetCache.size >= REJECTED_CACHE_MAX) {
    const firstKey = rejectedSetCache.keys().next().value as string | undefined
    if (firstKey) rejectedSetCache.delete(firstKey)
  }
  rejectedSetCache.set(txHash, rejected)
  return { kind: 'ok', rejected }
}

// Max blocks per eth_getLogs window. Default 10K suits Infura/Alchemy, but many
// public Base Sepolia RPCs cap eth_getLogs far lower (sepolia.base.org: 2000).
// Operators on a capped RPC set L2_LOG_CHUNK_BLOCKS=1500 (or their RPC's limit)
// to avoid "eth_getLogs range too large" errors + silently missed ranges.
// (zinsanjp / nyaromesama co-located V2 bring-up.)
const L2_LOG_CHUNK_BLOCKS = Number(process.env.L2_LOG_CHUNK_BLOCKS) || 10_000

// Distinguishes two very different reasons fetchPackedActionsFromTx can
// come back empty:
//   - 'not_applicable': the tx was fetched fine but isn't a
//     (safe)processActions/processActionsERC1271 call. This is expected and
//     harmless -- ActionsProcessed can in principle be emitted by txs this
//     gatherer doesn't need to unpack, and skipping it is correct, not a
//     failure.
//   - 'fetch_failed': we couldn't even get tx.data (RPC error, dropped
//     response) or couldn't parse it as a valid call. This means we don't
//     know what the tx actually was -- silently skipping this one is how
//     actions get permanently lost, since the caller uses this signal to
//     decide whether it's safe to advance the block cursor.
type FetchPackedActionsResult =
  | { kind: 'ok'; data: string }
  | { kind: 'not_applicable' }
  | { kind: 'fetch_failed' }

async function fetchPackedActionsFromTx(
  provider: { getTransaction: (h: string) => Promise<{ data?: string } | null> },
  txHash: string,
): Promise<FetchPackedActionsResult> {
  const hit = txDataCache.get(txHash)
  if (hit !== undefined) return { kind: 'ok', data: hit }
  let tx: { data?: string } | null
  try {
    tx = await provider.getTransaction(txHash)
  } catch {
    return { kind: 'fetch_failed' }
  }
  if (!tx?.data) return { kind: 'fetch_failed' }
  try {
    const parsed = PROCESS_ACTIONS_IFACE.parseTransaction({ data: tx.data })
    if (!parsed) return { kind: 'not_applicable' }
    if (
      parsed.name !== 'processActions' &&
      parsed.name !== 'safeProcessActions' &&
      parsed.name !== 'processActionsERC1271'
    ) return { kind: 'not_applicable' }
    const packed = parsed.args.packedActions as string
    if (txDataCache.size >= TX_CACHE_MAX) {
      const firstKey = txDataCache.keys().next().value as string | undefined
      if (firstKey) txDataCache.delete(firstKey)
    }
    txDataCache.set(txHash, packed)
    return { kind: 'ok', data: packed }
  } catch {
    // parseTransaction threw on malformed calldata -- we can't tell if this
    // was a genuinely unrelated tx or corrupted data from a bad RPC
    // response, so treat it as a fetch failure rather than assuming it's
    // safe to skip.
    return { kind: 'fetch_failed' }
  }
}

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
  // ActionsProcessed is now a calldata commitment. The packedActions payload
  // lives in the originating tx; fetchPackedActionsFromTx() pulls it.
  'event ActionsProcessed(uint32 indexed networkId, uint32 indexed validatorId, uint16 actionCount, bytes32 batchHash)'
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
    networkId: number
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

  // HTTP provider for reliable polling (WebSocket can die silently).
  // Uses makeFallbackJsonRpcProvider so L2_RPC_URL_HTTP_FALLBACK is honoured:
  // when the primary endpoint throttles or goes down, ethers rotates to the
  // next URL in the list without interrupting the poll loop. config.rpcUrl
  // is the bare wss:// URL from the caller; getL2HttpRpcUrls converts it to
  // an HTTP URL and appends any operator-configured fallback URLs.
  //
  // Note: fallback URLs may have different log-pruning windows (e.g. publicnode
  // Base Sepolia silently prunes historical logs; for backfills Coinbase's
  // sepolia.base.org is more reliable). Operators should keep that in mind
  // when choosing fallback URLs — pruning produces empty results, not errors.
  const l2HttpRpcUrls = getL2HttpRpcUrls(config.rpcUrl)
  const expectedL2ChainId = process.env.L2_CHAIN_ID ? Number(process.env.L2_CHAIN_ID) : config.chainId
  const httpProvider = await makeVerifiedFallbackJsonRpcProvider(l2HttpRpcUrls, expectedL2ChainId)
  if (l2HttpRpcUrls.length > 1) {
    console.log(`[RawEventsGatherer] HTTP RPC (with ${l2HttpRpcUrls.length - 1} fallback(s)): ${redactRpcUrl(l2HttpRpcUrls[0])}`)
  }
  const httpContract = new Contract(CAW_ACTIONS_ADDRESS, CONTRACT_ABI, httpProvider)
  // ERC-1271 sibling contract — only instantiated when an address is configured.
  const httpContractERC1271 = CAW_ACTIONS_ERC1271_ADDRESS
    ? new Contract(CAW_ACTIONS_ERC1271_ADDRESS, CONTRACT_ABI, httpProvider)
    : null

  const last = await config.rawEventsProvider.getLastProcessedEvent()
  // Resolve the historical-scan start block.
  //
  // A configured startBlock (config.json override or Network.creationBlock) is a
  // HARD FLOOR, even when the DB already has events. Previously `last` won
  // unconditionally, so if any CawActions event landed ABOVE the configured
  // startBlock before the historical scan ran (a live-poll/WS/peer event racing
  // cold start), getLastProcessedEvent pinned the floor there and every earlier
  // block was silently skipped — the DB looked "caught up" but was missing all
  // history below the stray event. (zinsanjp/nyaromesama: fresh caw_v2 started
  // ~137k blocks past the deploy block, capping Follow/Caw history.)
  //
  // Flooring at min(last, configured) is safe: the historical scan writes via
  // upsert (update:{}), so re-covering an already-present range is a no-op — no
  // double-processing, just gap-filling. So we never MISS history, and never
  // re-process what's already there.
  let startBlock: number
  if (config.startBlock !== undefined) {
    startBlock = last ? Math.min(last.blockNumber, config.startBlock) : config.startBlock
    if (last && config.startBlock < last.blockNumber) {
      console.log(`[RawEventsGatherer] Flooring scan at configured startBlock ${config.startBlock} (last event at ${last.blockNumber} — filling history below it)`)
    } else {
      console.log(`[RawEventsGatherer] Starting from configured startBlock ${startBlock}`)
    }
  } else if (last) {
    startBlock = last.blockNumber
  } else {
    startBlock = await httpProvider.getBlockNumber()
    console.log(`[RawEventsGatherer] Fresh DB, no startBlock configured — starting from current block ${startBlock}`)
  }
  // parentHash chain seed: only trust `last`'s hash when we're actually
  // resuming from it (no configured floor pulling us earlier); otherwise the
  // historical walk re-derives the chain from the floor.
  let lastHash = (config.startBlock === undefined && last) ? last.parentHash : 'genesis'

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
  // ActionsProcessed events now only carry a hash commitment; the actual
  // packed bytes live in the originating tx's calldata. We fetch tx.input
  // via eth_getTransactionByHash, decode the function args, then unpack and
  // chain parentHash SEQUENTIALLY (each depends on the prior). When the
  // provider exposes storeBatch, a single INSERT replaces what used to be N
  // sequential UPSERTs per event. Falls back to one-by-one storeEvent if no
  // batch method.
  async function processEvents(events: Log[], _contract: Contract) {
    for (const ev of events) {
      const packedResult = await fetchPackedActionsFromTx(httpProvider, ev.transactionHash)
      if (packedResult.kind === 'not_applicable') {
        // Tx fetched and parsed fine; it just isn't a (safe)processActions/
        // processActionsERC1271 call. Nothing to recover -- correctly skip.
        continue
      }
      if (packedResult.kind === 'fetch_failed') {
        // Could not fetch or parse the tx -- we don't know what actions (if
        // any) it contained. Throwing here (rather than skipping) is load-
        // bearing: the caller (poll()) only advances lastSyncedBlock after
        // processEvents() returns successfully. Skipping silently would let
        // the cursor move past this block, permanently losing any actions
        // in it if this really was an RPC hiccup rather than a benign
        // "unrelated tx" case. Throwing forces a retry on the next poll
        // tick (or RPC fallback rotation) instead.
        throw new Error(`[RawEventsGatherer] Could not fetch/parse packedActions calldata for tx ${ev.transactionHash} (block ${ev.blockNumber}) — aborting batch to retry`)
      }
      const packedHex = packedResult.data
      const packedBuf = new Uint8Array((packedHex.startsWith('0x') ? packedHex.slice(2) : packedHex).match(/.{2}/g)!.map(b => parseInt(b, 16)))
      const actions = unpackActions(packedBuf)

      // packedActions is the FULL submitted batch, INCLUDING actions the
      // contract rejected per-item in safeProcessActions (bad sig, senderId=0/
      // ownerOf revert, cawonce race, insufficient balance, etc.) — see the
      // contract's own comment above its ActionsProcessed emit. Cross-reference
      // ActionRejected logs from the same receipt to know which (senderId,
      // cawonce) pairs never actually applied to chain state, so we don't
      // persist a RawEvent for something the contract discarded.
      const rejectedResult = await fetchRejectedSetFromTx(httpProvider, ev.transactionHash)
      if (rejectedResult.kind === 'fetch_failed') {
        // Same load-bearing reasoning as the packedActions fetch_failed path
        // above: we cannot tell which actions were rejected, so persisting
        // anything here risks either writing a rejected (phantom) action or
        // -- if we guessed and skipped a good one -- losing a real action.
        // Throw to abort the batch and retry rather than guess.
        throw new Error(`[RawEventsGatherer] Could not fetch/parse ActionRejected logs for tx ${ev.transactionHash} (block ${ev.blockNumber}) — aborting batch to retry`)
      }
      const rejectedSet = rejectedResult.rejected

      // Build the full batch in one pass. parentHash must chain sequentially,
      // but the inserts themselves don't need to.
      //
      // Cross-client ingest: we persist EVERY client's actions, not just our
      // own. RewardMultiplier inflation is a global on-chain fact (any client
      // calling CawActions ticks it up for all stakers), so the activity
      // chart needs the full action stream to attribute staking rewards
      // correctly. Cross-client likes/follows/tips on caws we have indexed
      // also need to land in our domain rows. The CAW/RECAW domain handlers
      // gate on networkId so we don't pollute our feed with other clients'
      // posts — see domainProcessor.ts.
      const batch: RawEventInput[] = []
      let skippedCount = 0
      const skippedKeys: string[] = []
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i]
        const action = {
          actionType:      a.actionType,
          senderId:        a.senderId,
          receiverId:      a.receiverId,
          receiverCawonce: a.receiverCawonce,
          networkId:       a.networkId,
          cawonce:         a.cawonce,
          recipients:      a.recipients,
          amounts:         a.amounts,
          text:            decompressEventText(a.text)
        }
        // Offset logIndex by action position within the batch so each action
        // gets a unique (blockNumber, logIndex, transactionHash) key. Derived
        // from the original loop index i (not a compacted post-skip index) so
        // keys stay stable across re-index even when some i are skipped below.
        const logIndex = ((ev as any).index ?? (ev as any).logIndex ?? 0) + i
        // ALWAYS advance the hash chain for every action in packed order,
        // rejected included — the on-chain batchHash = keccak256(packedActions)
        // commits to the FULL batch in packed order, and this local parentHash
        // chain must mirror that ordering or it diverges from the on-chain
        // commitment.
        lastHash = hashNext(lastHash, action)
        if (rejectedSet.has(rejectedKey(a.senderId, a.cawonce))) {
          // Contract rejected this action -- it never took effect on-chain,
          // so it must not become a processable RawEvent downstream.
          skippedCount++
          skippedKeys.push(rejectedKey(a.senderId, a.cawonce))
          continue
        }
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

      if (skippedCount > 0) {
        console.log(`[RawEventsGatherer] Skipped ${skippedCount} contract-rejected action(s) in tx ${ev.transactionHash} (senderId:cawonce = ${skippedKeys.join(', ')})`)
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

  // Fetch historical events using HTTP provider (more reliable than WSS for
  // bulk reads). Chunked via scanLogsForward because public RPCs (publicnode,
  // free-tier Infura) cap eth_getLogs at ~50K blocks per request — scanning
  // from a months-old startBlock to `latest` in one call fails outright. We
  // resolve `latest` to a concrete number first so the chunk math is well-
  // defined, then walk forward in 10K-block windows. scanLogsForward halves
  // and retries on any single-window failure (e.g. when a chunk happens to
  // span an unusually log-dense block range).
  //
  // NOTE: deliberately NOT filtering on the indexed networkId topic at the
  // RPC level. Cross-client ingest (master commit f14ef50) is required for
  // the staking-rewards math to match chain truth — RewardMultiplier inflation
  // is a global on-chain fact triggered by ANY client's actions. The networkId
  // gate now lives in domainProcessor for CAW/RECAW only; everything else
  // processes regardless of submitting client.
  let past: Log[]
  const eventSig = httpContract.interface.getEvent('ActionsProcessed')!.topicHash
  while (true) {
    try {
      const latest = await httpProvider.getBlockNumber()
      if (startBlock > latest) {
        past = []
        break
      }
      console.log(`[RawEventsGatherer] Historical sync: blocks ${startBlock} → ${latest} (${latest - startBlock} blocks)`)

      // Scan CawActions logs (sig path).
      const rawLogs = await scanLogsForward(
        httpProvider,
        CAW_ACTIONS_ADDRESS,
        [eventSig],
        startBlock,
        latest,
        {
          chunkBlocks: L2_LOG_CHUNK_BLOCKS,
          // Don't cap windows here — historical sync MUST find every event,
          // and operators with multi-month gaps need an unbounded walk.
          // 10K * 100K = 1B blocks of headroom; nothing realistic hits that.
          maxWindows: 100_000,
          onProgress: (from, to, n) => {
            if (n > 0) console.log(`[RawEventsGatherer] Historical chunk ${from}..${to}: ${n} events`)
          },
        },
      )

      // Scan CawActionsERC1271 logs (ERC-1271 path) if the sibling is deployed.
      let erc1271Logs: typeof rawLogs = []
      if (CAW_ACTIONS_ERC1271_ADDRESS) {
        erc1271Logs = await scanLogsForward(
          httpProvider,
          CAW_ACTIONS_ERC1271_ADDRESS,
          [eventSig],
          startBlock,
          latest,
          {
            chunkBlocks: L2_LOG_CHUNK_BLOCKS,
            maxWindows: 100_000,
            onProgress: (from, to, n) => {
              if (n > 0) console.log(`[RawEventsGatherer] Historical ERC-1271 chunk ${from}..${to}: ${n} events`)
            },
          },
        )
      }

      // Merge and sort by (blockNumber, logIndex) so parentHash chains correctly.
      const allLogs = [...rawLogs, ...erc1271Logs].sort((a, b) =>
        a.blockNumber !== b.blockNumber
          ? a.blockNumber - b.blockNumber
          : a.index - b.index
      )
      past = allLogs as unknown as Log[]
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
      // Pass the L2 WS secret through explicitly. config.rpcUrl is the bare
      // wss:// URL from env; the secret lives in L2_RPC_SECRET and never
      // gets URL-embedded — see extractEmbeddedAuth() comment for why.
      wsProvider = makeWebSocketProvider(config.rpcUrl, config.chainId, getL2WsSecret())
      wsContract = new Contract(CAW_ACTIONS_ADDRESS, CONTRACT_ABI, wsProvider)
      // ERC-1271 sibling WS contract, if deployed on this chain.
      let wsContractERC1271: Contract | null = CAW_ACTIONS_ERC1271_ADDRESS
        ? new Contract(CAW_ACTIONS_ERC1271_ADDRESS, CONTRACT_ABI, wsProvider)
        : null

      // Signature: ActionsProcessed(uint32 indexed networkId, uint32 indexed validatorId, uint16 actionCount, bytes32 batchHash)
      // We don't need the topic args here — we always go to tx calldata for the bytes.
      wsContract.on('ActionsProcessed', async (
        _networkId: number, _validatorId: number, _actionCount: number, _batchHash: string,
        ev: ContractEventPayload,
      ) => {
        console.log("[RawEventsGatherer] Raw event received via WebSocket", ev)
        try {
          const packedResult = await fetchPackedActionsFromTx(httpProvider, ev.log.transactionHash)
          if (packedResult.kind !== 'ok') {
            // WebSocket path has no block-cursor to protect (HTTP polling
            // is the source of truth for lastSyncedBlock), so there's
            // nothing to lose by skipping here beyond this one event --
            // unlike processEvents() above, throwing wouldn't prevent any
            // cursor advancement. If this was a genuine RPC hiccup, the
            // HTTP poller's own fetch of the same tx will still throw and
            // retry correctly.
            if (packedResult.kind === 'fetch_failed') {
              console.warn(`[RawEventsGatherer] WS: could not fetch packedActions calldata for tx ${ev.log.transactionHash} — skipping (HTTP poller will retry if this was an RPC error)`)
            }
            return
          }
          const packedHex = packedResult.data
          const packedBuf = new Uint8Array((packedHex.startsWith('0x') ? packedHex.slice(2) : packedHex).match(/.{2}/g)!.map(b => parseInt(b, 16)))
          const wsActions = unpackActions(packedBuf)

          // Cross-reference ActionRejected logs from the same receipt — see
          // processEvents() for the full rationale. Same no-cursor-to-protect
          // reasoning as the packedActions fetch above: on failure, skip this
          // one WS event rather than throw; the HTTP poller's own fetch of
          // this tx will retry correctly if it was a genuine RPC hiccup.
          const rejectedResult = await fetchRejectedSetFromTx(httpProvider, ev.log.transactionHash)
          if (rejectedResult.kind !== 'ok') {
            console.warn(`[RawEventsGatherer] WS: could not fetch ActionRejected logs for tx ${ev.log.transactionHash} — skipping (HTTP poller will retry if this was an RPC error)`)
            return
          }
          const wsRejectedSet = rejectedResult.rejected

          // Build batch, then either bulk-store or fall back to per-row.
          // Same pattern as processEvents() — parentHash chain stays sequential.
          const batch: RawEventInput[] = []
          let wsSkippedCount = 0
          const wsSkippedKeys: string[] = []
          for (let i = 0; i < wsActions.length; i++) {
            const a = wsActions[i]
            // Cross-client ingest — see processEvents() for rationale.
            const action = {
              actionType:      a.actionType,
              senderId:        a.senderId,
              receiverId:      a.receiverId,
              receiverCawonce: a.receiverCawonce,
              networkId:       a.networkId,
              cawonce:         a.cawonce,
              recipients:      a.recipients,
              amounts:         a.amounts,
              text:            decompressEventText(a.text)
            }
            const logIndex = (ev.log.index ?? 0) + i
            // ALWAYS advance the hash chain, rejected included — see
            // processEvents() for why this must mirror on-chain batchHash order.
            lastHash = hashNext(lastHash, action)
            if (wsRejectedSet.has(rejectedKey(a.senderId, a.cawonce))) {
              wsSkippedCount++
              wsSkippedKeys.push(rejectedKey(a.senderId, a.cawonce))
              continue
            }
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

          if (wsSkippedCount > 0) {
            console.log(`[RawEventsGatherer] Skipped ${wsSkippedCount} contract-rejected action(s) in tx ${ev.log.transactionHash} (senderId:cawonce = ${wsSkippedKeys.join(', ')})`)
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

      // Subscribe the ERC-1271 sibling to the same handler when deployed.
      // The handler is identical — fetchPackedActionsFromTx dispatches on
      // the parsed function name, so the correct outer decoder runs regardless
      // of which contract emitted the event.
      if (wsContractERC1271) {
        wsContractERC1271.on('ActionsProcessed', async (
          _networkId: number, _validatorId: number, _actionCount: number, _batchHash: string,
          ev: ContractEventPayload,
        ) => {
          console.log("[RawEventsGatherer] ERC-1271 raw event received via WebSocket", ev)
          try {
            const packedResult = await fetchPackedActionsFromTx(httpProvider, ev.log.transactionHash)
            if (packedResult.kind !== 'ok') {
              // Same reasoning as the sibling WS handler above: no
              // block-cursor to protect here, and the HTTP poller's own
              // fetch of this tx will throw+retry if this was a genuine
              // RPC failure.
              if (packedResult.kind === 'fetch_failed') {
                console.warn(`[RawEventsGatherer] WS ERC-1271: could not fetch packedActions calldata for tx ${ev.log.transactionHash} — skipping (HTTP poller will retry if this was an RPC error)`)
              }
              return
            }
            const packedHex = packedResult.data
            const packedBuf = new Uint8Array((packedHex.startsWith('0x') ? packedHex.slice(2) : packedHex).match(/.{2}/g)!.map(b => parseInt(b, 16)))
            const wsActions = unpackActions(packedBuf)

            // Cross-reference ActionRejected logs from the same receipt — see
            // processEvents() for the full rationale. No cursor to protect
            // here either; skip this one event on failure rather than throw.
            const rejectedResult = await fetchRejectedSetFromTx(httpProvider, ev.log.transactionHash)
            if (rejectedResult.kind !== 'ok') {
              console.warn(`[RawEventsGatherer] WS ERC-1271: could not fetch ActionRejected logs for tx ${ev.log.transactionHash} — skipping (HTTP poller will retry if this was an RPC error)`)
              return
            }
            const wsRejectedSet = rejectedResult.rejected

            const batch: RawEventInput[] = []
            let wsSkippedCount = 0
            const wsSkippedKeys: string[] = []
            for (let i = 0; i < wsActions.length; i++) {
              const a = wsActions[i]
              const action = {
                actionType:      a.actionType,
                senderId:        a.senderId,
                receiverId:      a.receiverId,
                receiverCawonce: a.receiverCawonce,
                networkId:       a.networkId,
                cawonce:         a.cawonce,
                recipients:      a.recipients,
                amounts:         a.amounts,
                text:            decompressEventText(a.text)
              }
              const logIndex = (ev.log.index ?? 0) + i
              // ALWAYS advance the hash chain, rejected included — see
              // processEvents() for why this must mirror on-chain batchHash order.
              lastHash = hashNext(lastHash, action)
              if (wsRejectedSet.has(rejectedKey(a.senderId, a.cawonce))) {
                wsSkippedCount++
                wsSkippedKeys.push(rejectedKey(a.senderId, a.cawonce))
                continue
              }
              batch.push({
                chainId:         config.chainId,
                blockNumber:     ev.log.blockNumber,
                logIndex,
                transactionHash: ev.log.transactionHash,
                parentHash:      lastHash,
                data:            action,
                topics:          [ ...ev.log.topics ],
                contractAddress: ev.log.address
              })
            }

            if (wsSkippedCount > 0) {
              console.log(`[RawEventsGatherer] Skipped ${wsSkippedCount} contract-rejected action(s) in tx ${ev.log.transactionHash} (senderId:cawonce = ${wsSkippedKeys.join(', ')})`)
            }

            if (config.rawEventsProvider.storeBatch) {
              await config.rawEventsProvider.storeBatch(batch)
            } else {
              for (const entry of batch) {
                await config.rawEventsProvider.storeEvent(entry)
              }
            }
          } catch (err) {
            console.error("[RawEventsGatherer] FAILED to process ERC-1271 raw event from WebSocket", err)
          }
        })
      }

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
  // Seed indexer-health snapshot with the post-historical-sync watermark so
  // the validator's lag check sees a real value on cold start, not 0.
  recordIndexerProgress(config.chainId, lastSyncedBlock)

  // Cap each poll's range so a service waking up far behind can't request
  // millions of logs in one call. Shares the L2_LOG_CHUNK_BLOCKS knob so a
  // capped-RPC operator bounds both the historical chunk and the per-poll
  // range with one setting.
  const MAX_POLL_BLOCKS = L2_LOG_CHUNK_BLOCKS
  // Poll to one block below the head rather than to the head itself.
  //
  // getBlockNumber and getLogs are separate calls, and with a
  // FallbackProvider (quorum 1, first success wins) they can be answered by
  // different upstreams. Measured on Base Sepolia across two providers:
  // heads differ by one block about 17% of the time, never more, always in
  // the same direction. When the higher one answers getBlockNumber and the
  // lower one serves the getLogs, the range overshoots and the provider
  // rejects it with -32602 "block range extends beyond current head block".
  //
  // Nothing is lost when that happens — lastSyncedBlock doesn't advance and
  // the next tick re-requests the same range — but it puts a recoverable
  // error in the log at the same severity as a real one. This margin
  // removes that class at the skew this codebase can currently observe; a
  // wider skew would still overshoot, and the underlying issue is mixing
  // heads from providers that don't agree.
  // Default 1. Operators whose upstreams drift further apart can raise it;
  // 0 restores the previous behaviour of polling to the head itself.
  const envHeadMargin = Number(process.env.RAW_EVENTS_HEAD_MARGIN)
  const HEAD_MARGIN_BLOCKS =
    Number.isFinite(envHeadMargin) && envHeadMargin >= 0 ? envHeadMargin : 1
  // 30s default — actions are already shown in the feed optimistically as
  // soon as the user signs (PostForm's optimistic insert path), so the
  // indexer only sets the SUCCESS status flag a beat later. Stretching
  // from 15s → 30s halves eth_getLogs hits with imperceptible UX impact:
  // the only visible difference is a confirmed badge appearing a few
  // seconds later. Ops who need tighter timing override via
  // RAW_EVENTS_POLL_MS.
  const POLL_INTERVAL_MS = Number(process.env.RAW_EVENTS_POLL_MS) || 30000

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
      const range = computePollRange(currentBlock, lastSyncedBlock, HEAD_MARGIN_BLOCKS, MAX_POLL_BLOCKS)
      if (range) {
        const { head, toBlock } = range
        if (toBlock < head) {
          console.log(`[RawEventsGatherer] Catching up: polling ${lastSyncedBlock + 1}..${toBlock} (behind by ${currentBlock - toBlock} blocks)`)
        } else {
          console.log(`[RawEventsGatherer] Polling for events ${lastSyncedBlock + 1}..${toBlock}`)
        }
        const sigEvents = await httpContract.queryFilter(
          httpContract.filters.ActionsProcessed(config.networkId),
          lastSyncedBlock + 1,
          toBlock
        ) as unknown as Log[]

        // Also poll the ERC-1271 sibling when deployed.
        const erc1271Events: Log[] = httpContractERC1271
          ? (await httpContractERC1271.queryFilter(
              httpContractERC1271.filters.ActionsProcessed(config.networkId),
              lastSyncedBlock + 1,
              toBlock
            ) as unknown as Log[])
          : []

        // Merge and sort by (blockNumber, logIndex) to preserve canonical order.
        const events: Log[] = [...sigEvents, ...erc1271Events].sort((a, b) =>
          (a as any).blockNumber !== (b as any).blockNumber
            ? (a as any).blockNumber - (b as any).blockNumber
            : ((a as any).index ?? (a as any).logIndex ?? 0) - ((b as any).index ?? (b as any).logIndex ?? 0)
        )

        if (events.length > 0) {
          // Span scope is "actually processing fetched events" — the
          // getBlockNumber + queryFilter calls above are auto-instrumented
          // by the http instrumentation, so they show up regardless.
          await span('rawevents.process', {
            'events.count': events.length,
            'block.from': lastSyncedBlock + 1,
            'block.to': toBlock,
          }, () => processEvents(events, httpContract))
          console.log(`[RawEventsGatherer] Polled ${events.length} event(s)`)
        }
        lastSyncedBlock = toBlock
      }
      // Always publish the current high-water mark — even on a quiet poll
      // (no new events, toBlock equals head), the indexer is up
      // to that block and that's the freshness signal the validator needs.
      recordIndexerProgress(config.chainId, lastSyncedBlock)
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


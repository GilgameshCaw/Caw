// src/services/ValidatorService/index.ts

import { z } from 'zod'
import 'dotenv/config'
import { Service } from '../../Service'
import { prisma }  from '../../prismaClient'
import getActionType from '../../abi/getActionType'
import { cawActionsAbi } from '../../abi/generated'
import { CAW_ACTIONS_ADDRESS, CAW_ACTIONS_ERC1271_ADDRESS, CAW_ADDRESS, WETH_ADDRESS, CAW_ACTIONS_ARCHIVE_ADDRESS, CAW_CHALLENGE_RELAY_ADDRESS } from '../../abi/addresses'
import { deployments, type Env, type ChainKey } from '../../abi/deployments'
import { WebSocketProvider, JsonRpcProvider, Contract, Interface, keccak256, solidityPacked, AbiCoder } from 'ethers'
import { packActions, packSignatures, packGroupedSignatures, bytesToHex, getPackedActionSlices, unpackActions, unpackPerActionSigs } from '../../utils/packActions'
import { buildCheckpointMerkleTree } from '../../utils/checkpointMerkle'
import { tryClaimChallengeLock, releaseChallengeLock } from '../../utils/challengeLock'
import { foldCheckpointHashes } from '../../utils/foldCheckpointHashes'
import { scanLogsForward, scanLogsBackward } from '../../utils/chunkedLogs'
import { decompressActionText } from '../../utils/decompressActionText'
import { makeJsonRpcProvider, makeFallbackJsonRpcProvider, makeWebSocketProvider, getL2HttpRpcUrl, getL2HttpRpcUrls, getL2WsRpcUrl, getL2WsSecret, getEthMainnetHttpRpcUrl, getReplicationHttpRpcUrl, redactRpcUrl } from '../../utils/rpcProvider'
import { getIndexerStats } from '../../utils/indexerHealth'
import type { AbstractProvider } from 'ethers'
import { cawToEthCached, isPriceFresh } from '../ChainSyncService'
import { markTxQueueFailed as sharedMarkTxQueueFailed } from '../../utils/txQueueFailure'
import { incrementSessionSpent } from '../../utils/sessionSpendTracker'
import { span } from '../../utils/trace'
import { requireValidatorSigner, type ValidatorSigner } from '../../utils/signer'

// ABI for the new packed-calldata CawActions functions
const PACKED_ABI = [
  'function processActions(uint32 validatorId, bytes packedActions, bytes sigs, uint256 withdrawFee, uint256 withdrawLzTokenAmount) payable',
  'function safeProcessActions(uint32 validatorId, bytes packedActions, bytes sigs, uint256 withdrawFee, uint256 withdrawLzTokenAmount) payable returns (uint256 successCount, string[] rejections)',
  // ZK path. Only used when ZK_PROVER_ENABLED=1 AND a proof for this exact
  // (packedActions, packedSigs) tuple has been pre-staged in zkProofCache.
  // Falls back to processActions transparently if no proof is ready.
  'function processActionsWithZkSigs(uint32 validatorId, bytes packedActions, bytes packedSigs, bytes signers, bytes proof, uint256 withdrawFee, uint256 withdrawLzTokenAmount) payable',
  // ERC-1271 path: called on CawActionsERC1271 (sibling contract). Carries
  // per-group sigs (bytes[]) and rs (bytes32[]) instead of a single packed
  // bytes sigs. For each group g, rs[g] == keccak256(sigs[g]) is enforced
  // on-chain and is the value folded into the hash chain as ba.r.
  'function processActionsERC1271(uint32 validatorId, bytes packedActions, bytes[] sigs, bytes32[] rs, uint256 withdrawFee, uint256 withdrawLzTokenAmount) payable',
  // ActionsProcessed is a *commitment* to the calldata (packedActions lives
  // in the originating tx's input). Consumers who need the bytes call
  // decodePackedActionsFromTx() to fetch and decode them from tx.data.
  'event ActionsProcessed(uint32 indexed networkId, uint32 indexed validatorId, uint16 actionCount, bytes32 batchHash)',
  'event ActionsProcessedZk(uint32 indexed networkId, uint32 indexed validatorId, uint16 actionCount, uint256 actionsExecutedBitmap, bytes32 batchHash)',
  'event ActionRejected(uint32 senderId, uint32 cawonce, string reason)',
]
const packedIface = new Interface(PACKED_ABI)

// In-memory cache of pre-generated proofs, keyed by keccak256(packedActions || packedSigs).
// A separate background worker (not yet wired) is the producer. The validator's
// hot path reads from this cache to decide whether to submit via the ZK entry
// point. Misses fall through to the sig path with no behavior change.
//
// Why in-memory rather than a persisted store: a stale proof would be useless
// — proofs commit to specific packedActions bytes, and the validator rebuilds
// those every batch. If the process restarts, in-flight proofs are lost; that's
// fine, the next sig-path submit is the recovery.
interface StagedZkProof {
  packedActions: string
  packedSigs: string
  signers: string         // packed 20-byte addresses, 0x-prefixed hex
  proof: string           // Groth16 proof bytes, 0x-prefixed hex
  domainSeparator: string // sanity-check field; mismatch here is a bug
}
const zkProofCache = new Map<string, StagedZkProof>()

/** Cache key for a (packedActions, packedSigs) tuple. */
function zkCacheKey(packedActions: string, packedSigs: string): string {
  return keccak256(solidityPacked(['bytes', 'bytes'], [packedActions, packedSigs]))
}

/**
 * Stage a proof for a batch the validator will submit later. Producer side
 * of the cache. Called from the (still dormant) background prover.
 */
export function stageZkProof(p: StagedZkProof): void {
  zkProofCache.set(zkCacheKey(p.packedActions, p.packedSigs), p)
}

/** Non-mutating: returns the staged proof if any. */
function peekZkProof(packedActions: string, packedSigs: string): StagedZkProof | null {
  return zkProofCache.get(zkCacheKey(packedActions, packedSigs)) ?? null
}

/** Single-use: reads + deletes. Caller must be the one actually submitting. */
function consumeZkProof(packedActions: string, packedSigs: string): StagedZkProof | null {
  const key = zkCacheKey(packedActions, packedSigs)
  const p = zkProofCache.get(key)
  if (!p) return null
  zkProofCache.delete(key)
  return p
}

function isZkProverEnabled(): boolean {
  return process.env.ZK_PROVER_ENABLED === '1'
}

/**
 * Pick the right CawActions calldata for this batch.
 *
 * Returns ZK-path calldata if (a) the env flag is on AND (b) a matching
 * proof is staged in the cache. Otherwise returns the sig-path calldata
 * exactly as before (the cache miss is the no-op fallback). Callers don't
 * branch on the result — they just send the bytes.
 */
function encodeProcessActionsCalldata(
  validatorId: number,
  multiData: { packedActions: string; packedSigs: string },
  quote: { withdrawFee: bigint; withdrawLzTokenAmount: bigint },
  opts: { consume: boolean },
): { calldata: string; isZk: boolean } {
  if (isZkProverEnabled()) {
    const staged = opts.consume
      ? consumeZkProof(multiData.packedActions, multiData.packedSigs)
      : peekZkProof(multiData.packedActions, multiData.packedSigs)
    if (staged) {
      const calldata = packedIface.encodeFunctionData('processActionsWithZkSigs', [
        validatorId,
        multiData.packedActions,
        multiData.packedSigs,
        staged.signers,
        staged.proof,
        quote.withdrawFee,
        quote.withdrawLzTokenAmount,
      ])
      return { calldata, isZk: true }
    }
  }
  const calldata = packedIface.encodeFunctionData('processActions', [
    validatorId,
    multiData.packedActions,
    multiData.packedSigs,
    quote.withdrawFee,
    quote.withdrawLzTokenAmount,
  ])
  return { calldata, isZk: false }
}

// Thin wrapper so this service's existing callers don't need to pass prisma
// on every invocation. Shared helper lives in utils/txQueueFailure so it can
// be reused from DataCleaner (which uses its own PrismaClient instance).
async function markTxQueueFailed(
  txQueueId: number,
  reason: string,
  senderId: number,
  actionData: any
): Promise<void> {
  return sharedMarkTxQueueFailed(prisma as any, txQueueId, reason, senderId, actionData)
}

// Mark a TxQueue row 'validated_by_peer' and bump the session-key spent
// counter exactly once. Five validator-loop branches converge on this
// terminal state (awaiting_indexer recheck, pre-sim peer-mirror dedup,
// sub-batch processedByOther, allCawonceUsed batch, per-entry routing),
// so a naive `update` would risk double-incrementing the spend counter
// when two branches race on the same row.
//
// Idempotency strategy: atomic `updateMany` with a status guard on the
// non-terminal states. Only the branch whose updateMany returns count=1
// fires incrementSessionSpent; concurrent branches see count=0 and
// no-op. This ties the spend bump to the same write that flips status,
// so the two facts can't drift.
//
// Mirrors the increment behavior of the 'done' write path at L2891 —
// see project_session_spend_drift_on_peer_validated.md for the drift bug
// this closes. Action types that count toward spend are determined by
// incrementSessionSpent itself (early-returns at totalSpent === 0n for
// like/follow/recaw/etc.), matching the pre-sign gate's
// 'other' + 'withdraw' amounts[] sum (see project_quick_sign_spend_limit_units.md).
async function markTxQueueValidatedByPeer(
  txQueueId: number,
  payload: any,
  signedTx: string | null | undefined,
): Promise<boolean> {
  const result = await prisma.txQueue.updateMany({
    where: {
      id: txQueueId,
      status: { in: ['pending', 'processing', 'awaiting_indexer'] },
    },
    data: { status: 'validated_by_peer', reason: null },
  })
  if (result.count !== 1) return false
  if (signedTx && payload) {
    await incrementSessionSpent(prisma as any, payload as any, signedTx)
  }
  return true
}

// Mark a TxQueue row 'done' and bump the session-key spent counter exactly
// once. The sub-batch finalize path (multi-client split, ~L2454) converges
// here; it previously wrote status='done' via a plain prisma.txQueue.update
// which silently skipped incrementSessionSpent, letting users over-spend
// their session limits (project_session_spend_drift_sub_batch_finalize.md).
//
// Idempotency strategy: same atomic updateMany + status-guard pattern as
// markTxQueueValidatedByPeer. Only the winner (count=1) fires the spend
// bump; concurrent paths (e.g. the main batch loop, a recheck) that race on
// the same row see count=0 and no-op. Ties the spend bump to the status
// flip so the two facts can't drift apart.
//
// The main batch finalize path (L2964+) writes 'done' + calls
// incrementSessionSpent inline; that path has no concurrency risk because it
// loops sequentially inside a single await Promise.all slice. The sub-batch
// path is similar but it is cleanest to funnel through this helper so the
// idempotency guarantee is explicit.
async function markTxQueueDone(
  txQueueId: number,
  payload: any,
  signedTx: string | null | undefined,
): Promise<boolean> {
  const result = await prisma.txQueue.updateMany({
    where: {
      id: txQueueId,
      status: { in: ['pending', 'processing', 'awaiting_indexer'] },
    },
    data: { status: 'done', reason: null },
  })
  if (result.count !== 1) return false
  if (signedTx && payload) {
    await incrementSessionSpent(prisma as any, payload as any, signedTx)
  }
  return true
}

// How long a txqueue can sit in 'awaiting_indexer' before we give up and
// declare it a real failure. The contract said the cawonce was used, but
// our local Action table never caught up — at that point we have to
// assume the indexer is broken or the action genuinely doesn't exist.
//
// History:
//   - Originally 60s. Failed legit posts whenever the indexer was even
//     mildly behind.
//   - 2026-05-10: bumped to 10min after RPC rate-limiting on the L2
//     endpoint slowed RawEventsGatherer + ActionProcessor enough that
//     legit posts got marked failed.
//   - 2026-05-11: discovered the 10min wall is still too aggressive
//     during compound backend stalls (Prisma transaction starvation +
//     ActionProcessor 15s tx timeout + L2 RPC throttling can push
//     indexer lag past 10min). Floor stays at 10min; ceiling is now
//     60min and the effective budget scales with measured indexer lag.
//     See indexerAwareAwaitingTimeoutMs().
const AWAITING_INDEXER_FLOOR_MS = 10 * 60_000
const AWAITING_INDEXER_CEILING_MS = 60 * 60_000

// Cached measure of how far behind chain-head the local Action table is.
// Refreshed at the top of every poll cycle (cheap: a single max(createdAt)
// query). Used to dynamically widen the awaiting_indexer budget when the
// indexer is severely lagged, so a 30-min indexer stall doesn't produce a
// wave of false-failure posts.
let lastObservedIndexerLagMs = 0

async function refreshIndexerLag(): Promise<void> {
  try {
    const row = await prisma.action.aggregate({ _max: { createdAt: true } })
    if (row._max.createdAt) {
      lastObservedIndexerLagMs = Math.max(0, Date.now() - row._max.createdAt.getTime())
    }
  } catch {
    // Don't let a metrics query failure halt the loop — leave stale lag in place.
  }
}

/**
 * Effective awaiting_indexer budget for the current poll cycle.
 *
 * Returns max(FLOOR, observedLag * 3), capped at CEILING. The 3× multiplier
 * gives the indexer enough time to catch up on its current backlog AND
 * process whatever else lands in the meantime. If the indexer is current,
 * we use FLOOR (10min) which is plenty for the typical race; if it's badly
 * behind, the budget stretches up to 60min so legitimate posts don't get
 * marked failed during a temporary stall.
 */
function indexerAwareAwaitingTimeoutMs(): number {
  return Math.min(
    AWAITING_INDEXER_CEILING_MS,
    Math.max(AWAITING_INDEXER_FLOOR_MS, lastObservedIndexerLagMs * 3),
  )
}


// Cache for cawActions.withdrawQuote() across the simulate → bisect →
// recalculate flow within a single batch lifetime. Same (tokenIds,
// amounts) tuple = same quote. 60s TTL is more than enough for a batch
// to land but short enough that LZ fee drift doesn't surprise us.
const withdrawQuoteCache = new Map<string, { quote: { nativeFee: bigint; lzTokenFee: bigint }; cachedAt: number }>()

// Module-level handle to the currently-running poll trigger. Set by
// start() once the loop is scheduled, so external callers (admin
// "Execute batch now" endpoint) can wake the loop without waiting for
// the next setTimeout tick. Two parts:
//   - `forceImmediatePoll` makes the next pollLoop tick bypass the
//     batch-accumulation wait (process whatever is queued, even if
//     it's a single non-priority action and maxWaitTime hasn't elapsed).
//   - `wakePollLoop` invokes safePollLoop() right away. start() wires
//     this to its local closure; before start() runs (or after stop()),
//     the ref is null and the flag-only path is taken on the next
//     scheduled tick.
let forceImmediatePoll = false
let wakePollLoop: (() => Promise<void>) | null = null

/**
 * Trigger an immediate validator poll, bypassing the batch wait. Used
 * by the admin "Execute batch now" button to push all pending TxQueue
 * rows through without waiting for maxWaitTime / checkInterval. Safe
 * to call when the service isn't running — the force flag persists
 * and is consumed on the next poll, but no immediate run is scheduled.
 */
export function triggerImmediateValidatorPoll(): { triggered: boolean; reason: string } {
  if (!wakePollLoop) {
    // No-op when the validator isn't running in this process (e.g.
    // api-only node). Don't set the flag — there's no consumer, and
    // it would persist as stale state.
    return { triggered: false, reason: 'validator not running on this node' }
  }
  forceImmediatePoll = true
  // Fire and forget — caller doesn't need to await the batch result.
  // The poll mutex (isPolling) prevents this from racing an in-flight
  // poll; if one's already running, the flag will be picked up on
  // its next iteration.
  wakePollLoop().catch(err => console.error('[Validator] triggered poll failed:', err))
  return { triggered: true, reason: 'validator running — immediate poll dispatched' }
}

/**
 * Compare a TxQueue payload against a candidate already-landed action.
 * Both shapes have actionType / receiverId / receiverCawonce / text. The
 * candidate's text is plaintext (whether sourced from an Action row that
 * RawEventsGatherer already decompressed, or freshly decompressed off-chain
 * by the backstop); the payload's text is the smltxt-compressed hex that
 * was signed for on-chain submission. Decompress the payload side for
 * comparison — never re-compress or pad the candidate, per the
 * "validator must not mutate signed bytes" rule.
 */
function sameActionAsPayload(payload: any, candidate: { actionType: any, receiverId: any, receiverCawonce: any, text?: string }): boolean {
  const dataTextPlain = decompressActionText(payload.text)
  return (
    Number(candidate.actionType ?? -1) === Number(payload.actionType) &&
    Number(candidate.receiverId ?? -1) === Number(payload.receiverId ?? 0) &&
    Number(candidate.receiverCawonce ?? -1) === Number(payload.receiverCawonce ?? 0) &&
    (candidate.text ?? '') === dataTextPlain
  )
}

/**
 * Layer-2 calldata backstop. When indexer-lag is acceptable but no local
 * Action row exists for a "Cawonce already used" rejection, scan recent
 * ActionsProcessed logs on-chain, decode their tx calldata, and search
 * for a packed action carrying our (senderId, cawonce). If found, run
 * the same payload-match used against the local row.
 *
 * Returns:
 *   'done'   — the slot was filled by a peer mirror with matching content.
 *   'failed' — slot filled with a DIFFERENT action (true collision) or
 *              not found in the scan window (truly lost or scan came back
 *              empty, both treated as failed — caller can retry the
 *              user's action with a fresh cawonce).
 */
async function backstopCawonceFromCalldata(
  provider: AbstractProvider,
  payload: any,
  rowAgeMs: number,
): Promise<'done' | 'failed'> {
  const eventSig = packedIface.getEvent('ActionsProcessed')!.topicHash
  // Scan back only as far as the failing TxQueue row is old. Any action
  // landing this user's (senderId, cawonce) before that row was created
  // can't be the one we're chasing — it's either an older confirmed
  // action that's already in our local Action table (so resolveCawonceUsed
  // wouldn't have reached the backstop), or a stale-cawonce-allocator
  // collision we DON'T want to claim as ours. A pad multiplier covers
  // clock skew + slow blocks; capped by maxWindows below.
  //
  // Base Sepolia: 2s nominal block time. Pad ×3 for safety.
  const NOMINAL_BLOCK_MS = 2000
  const PAD = 3
  const head = await provider.getBlockNumber()
  // Floor at 50 blocks so a row created seconds before the resolve still
  // gets a usable window — block timestamps and DB clocks aren't perfectly
  // synced and rowAgeMs near zero would otherwise produce a 0-block scan.
  const targetSpan = Math.max(50, Math.ceil((rowAgeMs / NOMINAL_BLOCK_MS) * PAD))
  const fromBlock = Math.max(0, head - targetSpan)

  const scanOpts = { fromBlock, toBlock: head, chunkBlocks: 10_000, maxWindows: 8 }
  let logs
  try {
    logs = await scanLogsBackward(provider, CAW_ACTIONS_ADDRESS, [eventSig], scanOpts)
  } catch (err) {
    console.warn(`[Validator] backstop: scanLogsBackward (ECDSA) failed — ${err instanceof Error ? err.message : String(err)}`)
    return 'failed'
  }
  // Also scan the ERC-1271 sibling contract when deployed. A peer mirror may
  // have landed the user's action via processActionsERC1271 on that contract,
  // which emits the same ActionsProcessed event but from a different address.
  if (CAW_ACTIONS_ERC1271_ADDRESS) {
    let logsERC1271: typeof logs
    try {
      logsERC1271 = await scanLogsBackward(provider, CAW_ACTIONS_ERC1271_ADDRESS, [eventSig], scanOpts)
    } catch (err) {
      console.warn(`[Validator] backstop: scanLogsBackward (ERC-1271) failed — ${err instanceof Error ? err.message : String(err)}`)
      // Non-fatal: still return whatever the ECDSA scan found.
      logsERC1271 = []
    }
    logs = [...logs, ...logsERC1271]
  }
  if (logs.length === 0) return 'failed'

  // De-dupe by tx hash; each tx can carry many actions but the calldata
  // is the same regardless of how many ActionsProcessed events it emits.
  // Build a txHash → emitting contract address map so the decode dispatch
  // below can branch on which contract (ECDSA vs ERC-1271) produced each tx.
  const txEmitter = new Map<string, string>()
  for (const l of logs) {
    if (!txEmitter.has(l.transactionHash)) {
      txEmitter.set(l.transactionHash, (l.address as string).toLowerCase())
    }
  }
  const txHashes = Array.from(txEmitter.keys())
  for (const txHash of txHashes) {
    let tx
    try {
      tx = await provider.getTransaction(txHash)
    } catch (err) {
      console.warn(`[Validator] backstop: getTransaction ${txHash} failed — ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    if (!tx?.data || tx.data === '0x') continue

    // Decode packedActions from the tx calldata. The two action-processing
    // contracts use different selectors; dispatch is keyed on the emitting
    // contract address recorded in txEmitter.
    //
    // IMPORTANT: this allowlist must be kept in sync with ALL action-submission
    // entry points across both contracts. When adding a new entry point, you
    // must update ALL FOUR of these sites:
    //   (a) PACKED_ABI constant (near top of this file)
    //   (b) this decode dispatch in backstopCawonceFromCalldata
    //   (c) reconstructCheckpointData (calldata decode section, ~L3628)
    //   (d) RawEventsGatherer's PROCESS_ACTIONS_IFACE in listenForRawEvents.ts
    //
    // Current allowlist:
    //   CAW_ACTIONS_ADDRESS        → processActions | safeProcessActions | processActionsWithZkSigs
    //   CAW_ACTIONS_ERC1271_ADDRESS → processActionsERC1271
    const emitter = txEmitter.get(txHash)!
    const erc1271Addr: string = CAW_ACTIONS_ERC1271_ADDRESS
    const isERC1271Tx = erc1271Addr !== '' && emitter === erc1271Addr.toLowerCase()

    let packedHex: string | undefined
    if (isERC1271Tx) {
      // ERC-1271 path: processActionsERC1271(uint32, bytes, bytes[], bytes32[], uint256, uint256)
      // packedActions is arg index 1.
      try {
        const decoded = packedIface.decodeFunctionData('processActionsERC1271', tx.data)
        packedHex = decoded[1] as string
      } catch {
        // Unexpected selector on the ERC-1271 contract — skip.
        continue
      }
    } else {
      // ECDSA path: processActions | safeProcessActions | processActionsWithZkSigs
      // packedActions is a named arg in all three.
      try {
        const parsed = packedIface.parseTransaction({ data: tx.data, value: tx.value })
        if (parsed && (parsed.name === 'processActions' || parsed.name === 'safeProcessActions' || parsed.name === 'processActionsWithZkSigs')) {
          packedHex = parsed.args.packedActions as string
        }
      } catch {
        // Not one of our function selectors — skip.
        continue
      }
    }
    if (!packedHex) continue

    let unpacked
    try {
      const packedBuf = new Uint8Array(
        (packedHex.startsWith('0x') ? packedHex.slice(2) : packedHex)
          .match(/.{2}/g)!.map(b => parseInt(b, 16)),
      )
      unpacked = unpackActions(packedBuf)
    } catch (err) {
      console.warn(`[Validator] backstop: unpackActions failed for tx ${txHash} — ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    for (const a of unpacked) {
      if (Number(a.senderId) !== Number(payload.senderId)) continue
      if (Number(a.cawonce) !== Number(payload.cawonce)) continue
      // Hit. Decompress the on-chain text and run the same match used
      // against local Action rows.
      const landedText = decompressActionText(a.text)
      const matches = sameActionAsPayload(payload, {
        actionType: a.actionType,
        receiverId: a.receiverId,
        receiverCawonce: a.receiverCawonce,
        text: landedText,
      })
      console.log(`[Validator] backstop: found (sender=${payload.senderId}, cawonce=${payload.cawonce}) in tx ${txHash} — ${matches ? 'matches payload (done)' : 'different action (failed)'}`)
      return matches ? 'done' : 'failed'
    }
  }
  // Walked every recent batch; the slot wasn't filled by any action with
  // our (senderId, cawonce). The bitmap-said-used implies some path set
  // it, but no packed-action evidence within the indexer-lag-aware
  // window means we can't validate it as ours — mark failed.
  console.log(`[Validator] backstop: (sender=${payload.senderId}, cawonce=${payload.cawonce}) not found in last ${txHashes.length} batch tx(es) — marking failed`)
  return 'failed'
}

/**
 * Resolve a "Cawonce already used" simulation rejection by checking our
 * local Action table.
 *
 * The contract is the source of truth on whether `(senderId, cawonce)` is
 * used, but it doesn't store the action contents — so to decide whether
 * the existing on-chain action is OURS (just not yet indexed locally) or
 * a genuine collision with a different action, we have to match the
 * contents against the Action row the ActionProcessor writes from the
 * `ActionsProcessed` event. That indexer can lag the chain by several
 * seconds, especially during retry storms — so when the row isn't there
 * yet, we defer instead of immediately failing.
 *
 * When the indexer-lag-aware budget elapses without a local row, two
 * extra layers gate the "failed" verdict:
 *   1. Indexer-lag gate. If chainHead - lastScannedBlock exceeds what
 *      the indexer could realistically have processed in the budget,
 *      return 'awaiting_indexer' — the silence is the indexer being
 *      stalled, not the action genuinely missing. The TxQueue stays
 *      in its current state for the next pass to recheck.
 *   2. Calldata backstop. With indexer fresh enough, scan recent
 *      ActionsProcessed events and their underlying tx calldata for
 *      a packed action carrying our (senderId, cawonce). Match or
 *      mismatch are both terminal verdicts; not-found is failed.
 *
 * Returns:
 *   'done'              — Action exists (locally or on-chain) and matches our payload.
 *   'failed'            — Different action at this cawonce, or scan window came back empty.
 *   'awaiting_indexer'  — Action row not present and either budget hasn't elapsed or indexer is stalled.
 */
// Resolve and cache the chainId from a provider once per process. Calling
// `provider.getNetwork()` per resolveCawonceUsed invocation would add an
// RPC roundtrip to a path that already has tight latency targets, but the
// active L2 doesn't change at runtime — the validator is bound to a single
// provider for its lifetime. This is the seam V2's "network" model will
// hook into; today it just reads the live provider rather than the
// hardcoded 84532 constant the rest of this file uses.
let _cachedChainId: number | null = null
async function resolveChainIdFromProvider(provider: AbstractProvider): Promise<number> {
  if (_cachedChainId !== null) return _cachedChainId
  try {
    const net = await provider.getNetwork()
    _cachedChainId = Number(net.chainId)
  } catch (err) {
    // Fall back to the Base Sepolia constant. Matches what every other
    // RPC site in this file does today; not a regression. Logged so the
    // operator can spot RPC issues in the noise.
    console.warn(`[Validator] resolveChainIdFromProvider: getNetwork failed, falling back to 84532 — ${err instanceof Error ? err.message : String(err)}`)
    _cachedChainId = 84532
  }
  return _cachedChainId
}

async function resolveCawonceUsed(
  data: any,
  firstSeenAt: Date | undefined,
  provider: AbstractProvider,
): Promise<'done' | 'failed' | 'awaiting_indexer'> {
  const existingAction = await prisma.action.findFirst({
    where: { senderId: data.senderId, cawonce: data.cawonce }
  })
  if (existingAction) {
    const ex = existingAction.data as any
    // ex.text is plaintext (decompressed by RawEventsGatherer before being
    // written to the Action row); data.text is the smltxt-compressed hex
    // we signed for on-chain submission. Comparing them directly always
    // returned false, which made the `same-action` check spuriously
    // 'failed' for the legitimate same-cawonce-already-landed case.
    // Decompress data.text for the comparison. Audit fix 2026-05-09
    // (Round 6 cross-layer agent CL-1 bonus).
    const sameAction = sameActionAsPayload(data, {
      actionType: ex?.actionType,
      receiverId: ex?.receiverId,
      receiverCawonce: ex?.receiverCawonce,
      text: ex?.text ?? '',
    })
    return sameAction ? 'done' : 'failed'
  }
  // No Action row yet. Either the indexer hasn't caught up, or the cawonce
  // really is a phantom (eg. used by a tx that failed receipt verification
  // but still triggered the on-chain bitmap). Give the indexer a window
  // sized to its current lag — short when caught up, long when stalled —
  // and if we've been waiting past that budget, treat it as a real failure.
  const budget = indexerAwareAwaitingTimeoutMs()
  if (!firstSeenAt || Date.now() - firstSeenAt.getTime() <= budget) {
    return 'awaiting_indexer'
  }

  // Budget elapsed. Before declaring failed, gate on indexer freshness.
  // If chainHead - lastScannedBlock is larger than what the indexer
  // could plausibly cover in `budget`, the silence is indexer lag —
  // don't burn the row yet.
  let chainHead: number
  try {
    chainHead = await provider.getBlockNumber()
  } catch (err) {
    // If we can't even read the head, we have no basis to declare
    // failure. Defer.
    console.warn(`[Validator] resolveCawonceUsed: getBlockNumber failed, deferring — ${err instanceof Error ? err.message : String(err)}`)
    return 'awaiting_indexer'
  }

  const chainId = await resolveChainIdFromProvider(provider)
  const stats = getIndexerStats(chainId)
  // Fallback throughput when the indexer hasn't produced enough samples
  // yet (cold start, or process just restarted). Conservative — on Base
  // Sepolia a healthy indexer processes ~tens of blocks/sec, but here
  // we'd rather defer one extra tick than burn a legit action.
  const FALLBACK_BLOCKS_PER_SEC = 1
  const throughput = stats.hasSamples && stats.throughputBlocksPerSec > 0
    ? stats.throughputBlocksPerSec
    : FALLBACK_BLOCKS_PER_SEC
  const SAFETY_MULTIPLIER = 1.5
  const tolerableLag = (budget / 1000) * throughput * SAFETY_MULTIPLIER
  const lag = stats.lastScannedBlock > 0
    ? Math.max(0, chainHead - stats.lastScannedBlock)
    : 0

  if (stats.lastScannedBlock > 0 && lag > tolerableLag) {
    console.log(`[Validator] resolveCawonceUsed: indexer lag=${lag} blocks > tolerable=${Math.round(tolerableLag)} (throughput=${throughput.toFixed(2)} blk/s, budget=${Math.round(budget/1000)}s) — deferring`)
    return 'awaiting_indexer'
  }

  // Indexer is caught up enough that any peer-landed action would have
  // been picked up by now. The local-row miss is either a real silent
  // loss or a phantom. Calldata backstop is the tiebreaker.
  //
  // Scan-window sizing: we want to look back only as far as the failing
  // TxQueue row's age — searching older history risks claiming an
  // unrelated old (senderId, cawonce) match as ours (would happen only
  // if the cawonce allocator misfired and re-used a long-confirmed slot;
  // we should mark that failed, not done). rowAgeMs is undefined when
  // firstSeenAt is missing — fall back to a sensible default that's
  // larger than typical validator latency but small enough to keep the
  // scan cheap.
  const rowAgeMs = firstSeenAt
    ? Math.max(0, Date.now() - firstSeenAt.getTime())
    : 60_000
  return backstopCawonceFromCalldata(provider, data, rowAgeMs)
}

/** Build { CAW: 3, LIKE: 2, ... } breakdown from submitted actions (which have actionType) */
function buildActionBreakdown(actions: any[]): Record<string, number> {
  const breakdown: Record<string, number> = {}
  for (const a of actions) {
    if (a.actionType === undefined) continue
    const type = getActionType(Number(a.actionType)).toString()
    breakdown[type] = (breakdown[type] || 0) + 1
  }
  return breakdown
}


// Uniswap V2 Router ABI (minimal for getAmountsOut) - fallback if cache is stale
const UNISWAP_V2_ROUTER_ABI = [
  {
    constant: true,
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'path', type: 'address[]' }
    ],
    name: 'getAmountsOut',
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    type: 'function'
  }
]

const UNISWAP_V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'

// Base Sepolia chain ID for testnet detection
const BASE_SEPOLIA_CHAIN_ID = 84532

// On testnet, gas is essentially free but we still want to validate the check works.
// This factor scales down the gas cost to simulate mainnet-like economics.
// e.g., if testnet gas is 1000x cheaper, we divide gas cost by 1000.
const TESTNET_GAS_SCALE_FACTOR = BigInt(10000)

// Cache for Uniswap router instance
let cachedRouter: Contract | null = null
let cachedMainnetProvider: JsonRpcProvider | null = null

/**
 * Get or create Uniswap V2 Router instance
 */
function getUniswapRouter(mainnetRpcUrl: string): Contract {
  if (!cachedRouter || !cachedMainnetProvider) {
    cachedMainnetProvider = makeJsonRpcProvider(mainnetRpcUrl, 1)
    cachedRouter = new Contract(UNISWAP_V2_ROUTER, UNISWAP_V2_ROUTER_ABI, cachedMainnetProvider)
  }
  return cachedRouter
}


// Tip constants - must match frontend actions.ts
// These are in whole CAW tokens (contract multiplies by 10^18 on-chain)
// At ~500k CAW = $0.01, 1k CAW ≈ $0.00002 per action
const DEFAULT_VALIDATOR_TIP = BigInt(process.env.VALIDATOR_BASE_TIP || "1000") // 1k CAW base tip

/** Live settings loaded from DB, refreshed each poll cycle */
const liveSettings = {
  validatorBaseTip: DEFAULT_VALIDATOR_TIP,
  /** Tip at or above which an action gets priority processing (next poll cycle, no batch wait).
   *  Actions between baseTip and priorityTip are processed on the normal batch cadence. */
  priorityTip: DEFAULT_VALIDATOR_TIP * 3n,
  // 30s default — actions are confirmed in the local feed optimistically
  // before the validator picks them up, so the user-visible cost of a slower
  // poll is just "the on-chain submission lands a beat later." Bumping from
  // 10s to 30s also encourages more action grouping per batch (cheaper gas
  // per user, more efficient validator), and matches a pure-RPC reduction
  // (fewer fetchPendingQueue ticks per hour). Priority-tipped actions still
  // skip the wait, so latency-sensitive flows are unaffected.
  // 60s default. The poll fetches pending TxQueue rows and runs an
  // eth_call simulation against the contract; both cost RPC. Standard
  // posts already show optimistically in the FE, so a slightly slower
  // confirm is invisible. Priority-tipped actions bypass the wait via
  // maxWaitTime, so latency-sensitive flows aren't affected.
  checkInterval: 60_000,
  minActionsPerBatch: 1,
  maxWaitTime: 10_000,    // 10s default — users shouldn't wait long for standard-tip posts
  // 120s default. The optimistic-replication loop scans pending
  // checkpoints + does several view calls per cycle; doubling the
  // interval roughly halves the RPC cost and replication is purely
  // background (no user-visible latency).
  replicationInterval: 120_000,
  /** If true, this validator processes actions with a zero tip (public-goods mode).
   *  If false (default), zero-tip actions are rejected and must be processed by a validator
   *  that opts in. Allows users to set "No tip" in Quick Sign for free-but-slow processing. */
  acceptZeroTip: false,
}

/** Load settings from ValidatorSetting table, falling back to defaults */
async function refreshSettings(configCheckInterval?: number) {
  try {
    const rows = await prisma.validatorSetting.findMany()
    const map = new Map(rows.map(r => [r.key, r.value]))
    if (map.has('validatorBaseTip'))    liveSettings.validatorBaseTip = BigInt(map.get('validatorBaseTip')!)
    if (map.has('priorityTip'))        liveSettings.priorityTip = BigInt(map.get('priorityTip')!) || DEFAULT_VALIDATOR_TIP * 3n
    if (map.has('checkInterval'))       liveSettings.checkInterval = Number(map.get('checkInterval')!) || configCheckInterval || 60_000
    if (map.has('minActionsPerBatch'))  liveSettings.minActionsPerBatch = Number(map.get('minActionsPerBatch')!) || 1
    if (map.has('maxWaitTime'))         liveSettings.maxWaitTime = Number(map.get('maxWaitTime')!) || 10_000
    if (map.has('replicationInterval')) liveSettings.replicationInterval = Number(map.get('replicationInterval')!) || 120_000
    if (map.has('acceptZeroTip'))       liveSettings.acceptZeroTip = map.get('acceptZeroTip') === 'true'
  } catch (e: any) {
    console.error('[Validator] Failed to refresh settings from DB:', e.message)
  }
}

/**
 * Calculate the minimum required tip for an action
 * @returns Minimum required tip in CAW
 */
function calculateMinimumTip(): bigint {
  return liveSettings.validatorBaseTip
}

/**
 * Check if an action's tip qualifies for priority processing (skip batch wait).
 * @param action The action data (tip is last element of amounts array)
 */
function isPriorityAction(action: any): boolean {
  const amounts = action.amounts || []
  if (amounts.length === 0) return false
  const tip = BigInt(amounts[amounts.length - 1] || '0')
  return tip >= liveSettings.priorityTip
}

/**
 * Validate that an action's tip is sufficient for the client's replication count.
 *
 * Two paths:
 *
 *   Manual-sign / explicit-tip: amounts.length > 0 → tip is the last entry.
 *
 *   Session-key with empty amounts[] (Quick-Sign default): the contract
 *     reads the tip rate from the session record on-chain. The TxQueue row
 *     pre-resolves it as `entryImplicitTip` at submission time so we don't
 *     need a per-action DB lookup here.
 *
 * @param action            The action data
 * @param entryImplicitTip  Pre-resolved implicit tip from TxQueue.implicitTip.
 *                          BigInt for session-signed actions; null for owner
 *                          sigs (which always carry an explicit tip if they
 *                          tip at all).
 */
async function validateActionTip(
  action: any,
  entryImplicitTip?: bigint | null,
): Promise<{ valid: boolean; reason?: string; required?: bigint; provided?: bigint }> {
  const requiredTip = calculateMinimumTip()

  // Get the tip from the action's amounts array (last element is the tip)
  const amounts = action.amounts || []
  if (amounts.length === 0) {
    // Session-key fast path — implicit tip pre-resolved at submission.
    if (entryImplicitTip !== null && entryImplicitTip !== undefined) {
      if (entryImplicitTip === 0n && liveSettings.acceptZeroTip) return { valid: true }
      if (entryImplicitTip < requiredTip) {
        return {
          valid: false,
          reason: `Insufficient implicit session tip: ${entryImplicitTip.toString()} < ${requiredTip.toString()} CAW`,
          required: requiredTip,
          provided: entryImplicitTip,
        }
      }
      return { valid: true, required: requiredTip, provided: entryImplicitTip }
    }
    // No amounts and no implicit tip — only acceptable if this validator
    // opts into zero-tip processing.
    if (liveSettings.acceptZeroTip) {
      return { valid: true }
    }
    return {
      valid: false,
      reason: `No tip provided. Required: ${requiredTip.toString()} CAW`,
      required: requiredTip,
      provided: BigInt(0)
    }
  }

  const providedTip = BigInt(amounts[amounts.length - 1] || '0')

  // Zero-tip path: opt-in only (public-goods validators).
  // Users who picked "No tip" in Quick Sign sign actions with tip=0; only validators that
  // opted into acceptZeroTip will process them.
  if (providedTip === 0n && liveSettings.acceptZeroTip) {
    return { valid: true }
  }

  if (providedTip < requiredTip) {
    console.log(`[Validator] Insufficient tip for action:`)
    console.log(`  - Required tip: ${requiredTip.toString()} CAW`)
    console.log(`  - Provided tip: ${providedTip.toString()} CAW`)
    return {
      valid: false,
      reason: `Insufficient tip: provided ${providedTip.toString()} CAW, required ${requiredTip.toString()} CAW`,
      required: requiredTip,
      provided: providedTip
    }
  }

  return { valid: true }
}

/**
 * Get unique network IDs from a batch of actions
 */
function getUniqueClientIds(actions: any[]): number[] {
  const networkIds = new Set<number>()
  for (const action of actions) {
    networkIds.add(action.networkId ?? 1)
  }
  return Array.from(networkIds)
}

/**
 * Split actions by network ID for batching
 * Returns map of networkId -> indices of actions for that network
 */
function groupActionsByClient(actions: any[]): Map<number, number[]> {
  const groups = new Map<number, number[]>()
  for (let i = 0; i < actions.length; i++) {
    const networkId = actions[i].networkId ?? 1
    if (!groups.has(networkId)) {
      groups.set(networkId, [])
    }
    groups.get(networkId)!.push(i)
  }
  return groups
}

/**
 * Convert CAW amount to ETH using cached price or Uniswap V2 getAmountsOut
 * @param cawAmount - Amount of CAW tokens (raw count, not wei)
 * @param mainnetRpcUrl - Mainnet RPC URL for Uniswap query (fallback)
 * @returns Amount of ETH (in wei) that the CAW would swap to
 */
async function cawToEth(cawAmount: bigint, mainnetRpcUrl: string): Promise<bigint> {
  if (cawAmount === BigInt(0)) {
    return BigInt(0)
  }

  // Try to use cached price first (refreshed every 5 minutes by ChainSyncService)
  if (isPriceFresh(10 * 60 * 1000)) { // Accept prices up to 10 minutes old
    const cachedResult = cawToEthCached(cawAmount)
    if (cachedResult !== null) {
      console.log(`[Validator] Using cached CAW/ETH price`)
      return cachedResult
    }
  }

  // Fallback to direct Uniswap query if cache is stale
  console.log(`[Validator] Cache miss - querying Uniswap directly`)
  try {
    const router = getUniswapRouter(mainnetRpcUrl)
    const path = [CAW_ADDRESS, WETH_ADDRESS]

    // CAW has 18 decimals, so cawAmount should already be in the correct units
    // But our tip is just the raw CAW count, so we need to add 18 decimals
    const cawAmountWithDecimals = cawAmount * BigInt(10 ** 18)

    const amounts = await router.getAmountsOut(cawAmountWithDecimals, path)
    const ethOut = BigInt(amounts[1])

    return ethOut
  } catch (error: any) {
    console.error('[Validator] Failed to convert CAW to ETH via Uniswap:', error.message)
    // Fallback: use approximate rate (this is a safety net)
    // ~16M wei per CAW based on historical rates
    return cawAmount * BigInt(16140000)
  }
}

/** natstat: validator configuration schema */
const ValidatorConfig = z.object({
  l2RpcUrl:      z.string(),
  ethMainnetRpcUrl: z.string().optional(), // Ethereum L1 mainnet for Uniswap CAW price
  validatorId:   z.number().int(),
  checkInterval: z.number().default(10_000)  // ms
})
type ValidatorConfig = z.infer<typeof ValidatorConfig>

/** natstat: the Validator service polls pending txQueue entries, simulates them,
 *  and submits only those whose tips cover gas + whose simulation passed.
 */
export const validatorService: Service = {
  name: 'Validator',

  validateConfig(raw) {
    const result = ValidatorConfig.safeParse(raw)
    return result.success
      ? []
      : result.error.errors.map(e => new Error(e.message))
  },

  start(rawCfg, ctx) {
    const cfg = ValidatorConfig.parse(rawCfg)
    // Prefer environment variable for RPC URL (never commit API keys to config)
    const l2RpcUrl = getL2WsRpcUrl() || cfg.l2RpcUrl
    // ETH L1 mainnet RPC for Uniswap CAW price queries (separate from L2 RPC)
    const ethMainnetRpcUrl = getEthMainnetHttpRpcUrl(cfg.ethMainnetRpcUrl) || 'https://eth.llamarpc.com'
    const { validatorId, checkInterval } = cfg

    if (!l2RpcUrl || l2RpcUrl.includes('${')) {
      throw new Error('Missing L2_RPC_URL in environment variables')
    }

    let provider: WebSocketProvider
    // `signer` replaces the former `wallet: Wallet`. The underlying ethers.Signer
    // is reached via signer.asEthersSigner() where Contract instantiation needs
    // it. Provider gets bound during initializeConnection() / rebuildHttpProvider().
    const signer: ValidatorSigner = requireValidatorSigner({})
    let cawActions: Contract
    let iface: any

    // Dedicated HTTP provider for read-heavy calls (eth_call with large calldata,
    // gas estimation, fee data). Infura WSS on Base Sepolia hangs/socket-hang-ups
    // under large eth_call payloads (we routinely simulate 50+ actions in one
    // call). HTTP handles these reliably. Subscriptions can stay on WSS.
    //
    // When L2_RPC_URL_HTTP_FALLBACK is set, this becomes a FallbackProvider
    // that rotates around dead/flaky endpoints. Without fallbacks the provider
    // collapses to a plain JsonRpcProvider (no quorum overhead). One sustained
    // Infura outage on Base Sepolia is what motivated this — the operator
    // can now drop in an Alchemy/Quicknode URL alongside Infura and the
    // validator routes around either.
    const l2HttpRpcUrls = getL2HttpRpcUrls(l2RpcUrl)
    // `let` (was `const`) so the no-WS error-recovery path can rebuild
    // the provider in place — see rebuildHttpProvider below for why.
    let httpProvider = makeFallbackJsonRpcProvider(l2HttpRpcUrls, 84532)
    if (l2HttpRpcUrls.length > 1) {
      console.log(`[Validator] HTTP RPC (with ${l2HttpRpcUrls.length - 1} fallback(s)): ${redactRpcUrl(l2HttpRpcUrls[0])}`)
    } else {
      console.log(`[Validator] HTTP RPC (for eth_call / gas): ${redactRpcUrl(l2HttpRpcUrls[0])}`)
    }

    /**
     * Rebuild httpProvider after a "provider destroyed" event without
     * going through initializeConnection (which has WS-specific cleanup
     * logic that would re-destroy the new provider). Re-binds the wallet
     * and cawActions Contract to the fresh provider so all downstream
     * eth_call / sendTransaction usage picks it up.
     *
     * Why this is necessary: when the no-WS path calls initializeConnection
     * for reconnect, line 401 sets `provider = httpProvider`. If a later
     * "provider destroyed" error triggers another initializeConnection,
     * the WS reinit branch destroys oldProvider — which IS httpProvider in
     * no-WS mode. Once destroyed, every subsequent eth_call through
     * cawActions throws "provider destroyed; cancelled request" and we're
     * stuck until pm2 restart. The WS-path destroy is now gated on USE_WS
     * (so it can't re-destroy httpProvider), and this helper is the
     * intentional rebuild path for the no-WS error case.
     */
    function rebuildHttpProvider(reason: string) {
      console.warn(`[Validator] Rebuilding httpProvider — reason: ${reason}`)
      httpProvider = makeFallbackJsonRpcProvider(l2HttpRpcUrls, 84532)
      if (!USE_WS) {
        provider = httpProvider as unknown as WebSocketProvider
        signer.reconnect(httpProvider)
        cawActions = new Contract(CAW_ACTIONS_ADDRESS, cawActionsAbi, signer.asEthersSigner())
        iface = cawActions.interface
      }
    }

    // Note: Uncaught exception handling is done at the process level in programs/start.ts
    // No need for service-specific handlers

    // WebSocket is DISABLED by default. Infura rate-limits eth_subscribe very
    // aggressively and reconnect storms were the biggest source of sustained
    // 429s in the stack. The validator doesn't actually need WS — every
    // read (simulation, gas, fee data) and write (tx submission) uses the
    // httpProvider path. WS was only being used as the wallet's default
    // provider. Re-enable with ENABLE_VALIDATOR_WS=1.
    const USE_WS = process.env.ENABLE_VALIDATOR_WS === '1'

    // Function to initialize/reinitialize the WebSocket connection
    async function initializeConnection() {
      if (!USE_WS) {
        // No-WS path: bind signer/contract to the HTTP provider instead.
        provider = httpProvider as unknown as WebSocketProvider
        signer.reconnect(httpProvider)
        cawActions = new Contract(CAW_ACTIONS_ADDRESS, cawActionsAbi, signer.asEthersSigner())
        iface = cawActions.interface
        console.log('[Validator] WebSocket disabled — using HTTP provider (set ENABLE_VALIDATOR_WS=1 to re-enable)')
        return
      }
      console.log('[Validator] Initializing WebSocket connection...')
      if (provider) {
        try {
          // Set a flag to prevent the provider from being used during cleanup
          const oldProvider = provider
          provider = null as any // Clear reference immediately

          // Safely destroy the old provider
          setTimeout(async () => {
            try {
              // Check if the WebSocket exists and its state
              const ws = (oldProvider as any)._websocket || (oldProvider as any).websocket
              if (ws) {
                const readyState = ws.readyState
                console.log(`[Validator] Old WebSocket state: ${readyState} (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED)`)

                // Only destroy if the WebSocket is OPEN (1) or already CLOSED (3)
                // Don't try to destroy CONNECTING (0) or CLOSING (2) sockets
                if (readyState === 1 || readyState === 3) {
                  oldProvider.destroy()
                  console.log('[Validator] Old provider destroyed successfully')
                } else {
                  // For CONNECTING or CLOSING states, just wait for it to close naturally
                  console.log('[Validator] Skipping destroy - WebSocket not in stable state')
                  if (readyState === 0) {
                    // If still connecting, wait a bit and try to close again
                    setTimeout(() => {
                      try {
                        if (ws.readyState === 1) {
                          ws.close()
                        }
                      } catch (e) {
                        // Ignore errors during delayed close
                      }
                    }, 1000)
                  }
                }
              } else {
                // No WebSocket found, safe to destroy
                oldProvider.destroy()
                console.log('[Validator] Old provider destroyed (no active WebSocket)')
              }
            } catch (e: any) {
              console.log('[Validator] Error destroying old provider (non-fatal):', e.message)
            }
          }, 500) // Longer delay to ensure operations complete
        } catch (e: any) {
          console.log('[Validator] Error during provider cleanup (non-fatal):', e.message)
        }
      }

      // Create new provider with error handling
      try {
        provider = makeWebSocketProvider(l2RpcUrl, 84532, getL2WsSecret()) // Base Sepolia chainId

        // Add error handler to the WebSocket immediately to catch connection errors
        const ws = (provider as any)._websocket || (provider as any).websocket
        if (ws) {
          ws.on('error', (error: Error) => {
            if (error.message?.includes('429')) {
              console.log('[Validator] WebSocket rate limited (429), will retry later')
            } else {
              console.log('[Validator] WebSocket error:', error.message)
            }
          })
        }

        signer.reconnect(provider)
        cawActions = new Contract(CAW_ACTIONS_ADDRESS, cawActionsAbi, signer.asEthersSigner())
        iface = cawActions.interface

        // Wait for the provider to be ready
        try {
          await provider.getNetwork()
          console.log('[Validator] WebSocket connection initialized and ready')
        } catch (e: any) {
          console.log('[Validator] WebSocket connection initialized (network check failed, will retry):', e.message)
        }
      } catch (e: any) {
        console.log('[Validator] Error creating WebSocket provider:', e.message)
        // Create a dummy provider to prevent errors
        provider = null as any
      }
    }

    // Initialize connection
    initializeConnection().catch(e => {
      console.log('[Validator] Error during initial connection, will retry:', e.message)
    })

    // On startup, reset ALL 'processing' entries back to 'pending'
    // These are definitely stale since we just started
    prisma.txQueue.updateMany({
      where: { status: 'processing' },
      data: { status: 'pending' }
    }).then(result => {
      if (result.count > 0) {
        console.log(`[Validator] Startup: Reset ${result.count} 'processing' entries back to 'pending'`)
      }
    }).catch(err => {
      console.error('[Validator] Startup: Failed to reset processing entries:', err.message)
    })

    let timer: NodeJS.Timeout

    /** natstat: load all pending queue entries */
    async function fetchPendingQueue() {
      // Reset any 'processing' entries older than 30 seconds (likely stale from timeout/crash)
      const thirtySecondsAgo = new Date(Date.now() - 30 * 1000)
      const resetCount = await prisma.txQueue.updateMany({
        where: {
          status: 'processing',
          updatedAt: { lt: thirtySecondsAgo }
        },
        data: { status: 'pending' }
      })
      if (resetCount.count > 0) {
        console.log(`[Validator] Reset ${resetCount.count} stale 'processing' entries back to 'pending'`)
      }

      // waiting_for_deposit lifecycle:
      //   - Rows carry pendingDepositTxHash as proof the client expects an L1 deposit
      //     to land on L2 shortly. They are NOT re-simulated by the validator — that
      //     would cycle them right back to failed. Instead, the DataCleaner watcher
      //     reads L2 on-chain state (authenticated[networkId][tokenId] and
      //     cawBalanceOf(tokenId)) and promotes them back to 'pending' only when the
      //     deposit has actually landed. The watcher also handles the 20-min timeout
      //     and failure path. The validator's only job here is to hard-fail any
      //     waiting row older than 25 minutes as a last-resort safety net in case
      //     the watcher is down.
      const twentyFiveMinutesAgo = new Date(Date.now() - 25 * 60 * 1000)
      const staleWaitingRows = await prisma.txQueue.findMany({
        where: {
          status: 'waiting_for_deposit',
          createdAt: { lt: twentyFiveMinutesAgo }
        },
        select: { id: true, senderId: true, payload: true }
      })
      if (staleWaitingRows.length > 0) {
        console.log(`[Validator] Safety net: failing ${staleWaitingRows.length} waiting_for_deposit rows older than 25 min`)
        for (const row of staleWaitingRows) {
          const data = (row.payload as any)?.data ?? {}
          await markTxQueueFailed(
            row.id,
            'Deposit did not arrive in time. Please try again.',
            row.senderId,
            data
          )
        }
      }

      // Pre-simulation hold: any pending row carrying a pendingDepositTxHash gets
      // moved to waiting_for_deposit WITHOUT simulation. Attempting to simulate
      // these would fail with "User has not authenticated with this client" or
      // "Insufficient CAW balance" (since L1→L2 hasn't propagated yet) and waste
      // an RPC call. The DataCleaner watcher will re-promote once L2 catches up.
      const heldCount = await prisma.txQueue.updateMany({
        where: {
          status: 'pending',
          pendingDepositTxHash: { not: null }
        },
        data: {
          status: 'waiting_for_deposit',
          reason: 'Waiting for L1 deposit to land on L2'
        }
      })
      if (heldCount.count > 0) {
        console.log(`[Validator] Pre-sim hold: moved ${heldCount.count} rows to waiting_for_deposit`)
      }

      // Pre-simulation hold for Quick Sign session registration: same shape as
      // the deposit hold above. The bundled mintAndDeposit+QuickSign flow registers
      // the session on L2 via the same LZ message that lands the deposit; until
      // that lands, simulating an action signed by the session key would fail with
      // "Session expired or not found". Reuse waiting_for_deposit as the holding
      // status — it already gets re-promoted on the same L2-watch cadence.
      const sessionHeldCount = await prisma.txQueue.updateMany({
        where: {
          status: 'pending',
          pendingQuickSignTxHash: { not: null }
        },
        data: {
          status: 'waiting_for_deposit',
          reason: 'Waiting for L1 Quick Sign session to land on L2'
        }
      })
      if (sessionHeldCount.count > 0) {
        console.log(`[Validator] Pre-sim hold: moved ${sessionHeldCount.count} session-pending rows to waiting_for_deposit`)
      }

      // awaiting_indexer recheck: rows where simulation reported "Cawonce
      // already used" but the local Action row hadn't been written yet.
      // Re-resolve against the Action table (now updated by ActionProcessor)
      // and either close them out or, if we've waited past the timeout,
      // fail them. Skip simulation entirely for these — the contract's
      // verdict on the cawonce hasn't changed; only our local view of the
      // action contents has.
      const awaitingRows = await prisma.txQueue.findMany({
        where: { status: 'awaiting_indexer' },
        // signedTx is needed for markTxQueueValidatedByPeer → incrementSessionSpent
        // (recovers signer to identify the session key to charge).
        select: { id: true, payload: true, senderId: true, updatedAt: true, signedTx: true },
      })
      if (awaitingRows.length > 0) {
        console.log(`[Validator] Rechecking ${awaitingRows.length} awaiting_indexer row(s)`)
        await Promise.all(awaitingRows.map(async (row) => {
          const data = (row.payload as any)?.data
          if (!data) return
          const resolution = await resolveCawonceUsed(data, row.updatedAt, httpProvider)
          if (resolution === 'done') {
            console.log(`[Validator] TxQueue ${row.id}: Action row now indexed and matches — marking done`)
            await markTxQueueValidatedByPeer(row.id, row.payload, row.signedTx)
            // Also mark the optimistic Caw row SUCCESS for caw/recaw actions, mirroring updateQueueStatuses.
            if (data.actionType === 0 || data.actionType === 'caw' || data.actionType === 3 || data.actionType === 'recaw') {
              await prisma.caw.update({
                where: { userId_cawonce: { userId: data.senderId, cawonce: data.cawonce } },
                data: { status: 'SUCCESS' },
              }).catch(() => {})
            }
          } else if (resolution === 'failed') {
            console.log(`[Validator] TxQueue ${row.id}: gave up on awaiting_indexer (different action or indexer timeout)`)
            await markTxQueueFailed(row.id, 'Cawonce already used', row.senderId, data)
          }
          // 'awaiting_indexer' — leave the row alone; do NOT re-update,
          // since that would bump updatedAt and reset the timeout.
        }))
      }

      // Fetch more candidates than we might use so we can stop at the size limit.
      // Base Sepolia transaction size limit is 128KB. We target ~80KB of action
      // data to leave headroom for signatures, arrays, and ABI encoding overhead.
      //
      // Secondary `id: 'asc'` is load-bearing: thread / batch submissions insert
      // every row in a single Promise.all so they share createdAt to the
      // millisecond. Without a tiebreaker, Postgres returns them in heap order
      // (typically reverse insert order), and `buildMultiActionData` then packs
      // them in the wrong sequence — the actionsHash computed on submission
      // diverges from what the user signed, ecrecover returns a random address,
      // the contract reverts with "Session expired or not found". Auto-increment
      // id is strictly monotonic per insert; chunk 0 always has the lower id.
      const candidates = await prisma.txQueue.findMany({
        where: { status: 'pending' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 256,
      })

      // Cross-mirror redundancy pre-check. The FE fans out every signed
      // action to peer mirrors; both mirrors race to submit the same
      // action, the chain picks one. The loser used to simulate the
      // action, get "Cawonce already used" back, and recover via
      // resolveCawonceUsed. That works but costs an eth_call per row
      // every poll until either the indexer catches up or the budget
      // expires — significant waste during a multi-user storm.
      //
      // Shortcut: if our local Action table already has a row for
      // (senderId, cawonce) AND its content matches our payload, this
      // action was already processed by some validator. Mark this row
      // done immediately and skip simulation entirely. resolveCawonceUsed
      // would have reached the same verdict; this just gets there
      // without burning the RPC call.
      const dedupedCandidates: typeof candidates = []
      for (const candidate of candidates) {
        const data = (candidate.payload as any)?.data
        if (!data || candidate.cawonce == null) {
          dedupedCandidates.push(candidate)
          continue
        }
        const existingAction = await prisma.action.findFirst({
          where: { senderId: candidate.senderId, cawonce: candidate.cawonce },
        })
        if (!existingAction) {
          dedupedCandidates.push(candidate)
          continue
        }
        const ex = existingAction.data as any
        const dataTextPlain = decompressActionText(data.text)
        const sameAction =
          Number(ex?.actionType ?? -1) === Number(data.actionType) &&
          Number(ex?.receiverId ?? -1) === Number(data.receiverId ?? 0) &&
          Number(ex?.receiverCawonce ?? -1) === Number(data.receiverCawonce ?? 0) &&
          (ex?.text ?? '') === dataTextPlain
        if (sameAction) {
          console.log(`[Validator] TxQueue ${candidate.id}: action already on chain (peer mirror submitted) — marking done without simulation`)
          await markTxQueueValidatedByPeer(candidate.id, (candidate as any).payload, (candidate as any).signedTx)
          // Mirror the SUCCESS state to optimistic Caw rows so the FE
          // stops showing pending.
          if (data.actionType === 0 || data.actionType === 'caw' || data.actionType === 3 || data.actionType === 'recaw') {
            await prisma.caw.update({
              where: { userId_cawonce: { userId: data.senderId, cawonce: data.cawonce } },
              data: { status: 'SUCCESS' },
            }).catch(() => {})
          }
          continue
        }
        // Action row exists but for a different action — let the
        // normal flow handle it (will hit "Cawonce already used"
        // during sim, then mark failed via resolveCawonceUsed →
        // 'failed' for a genuine different-action collision).
        dedupedCandidates.push(candidate)
      }
      // Shadow `candidates` with the filtered list so the rest of
      // this function (bounded-batch builder + downstream sim) sees
      // only entries that still need work. `candidates` was declared
      // const above; rebind via a fresh let in this scope.
      const remainingCandidates = dedupedCandidates

      // Bound the batch by estimated calldata size. With packed format, each
      // action is ~25 bytes fixed + 65 bytes sig = 90 bytes + text + arrays.
      // Cap at 120KB to leave margin below the 128KB protocol tx size limit.
      //
      // CRITICAL (audited 2026-04-27): rows that share a batchId share a
      // single ActionBatch signature whose actionsHash commits to ALL of
      // their packed slices. If we split such a group across two txs, each
      // tx will recover a DIFFERENT (wrong) signer from the truncated hash
      // and the contract reverts with "Session expired or not found". So
      // we never split a batch group: when adding the next entry would
      // overflow the calldata cap AND we're still inside a group that
      // started in this batch, we drop the WHOLE in-progress group and
      // try again next poll. If a single batch group genuinely doesn't
      // fit by itself, we mark every row in it failed with a clear
      // "Batch too large to submit" reason — the API now caps at 256
      // actions per batch (see /api/actions /batch), so this should be
      // unreachable in practice unless text payloads are huge.
      const MAX_BATCH_CALLDATA_BYTES = 120_000
      const PER_ACTION_OVERHEAD = 90 // packed fixed fields (25) + sig (65)
      let runningSize = 500 // base overhead for the outer function call
      const bounded: typeof candidates = []
      const groupAccumulators: Array<{ batchId: number; startIdx: number; bytes: number }> = []
      let currentGroup: { batchId: number; startIdx: number; bytes: number } | null = null

      const entrySize = (entry: typeof candidates[number]) => {
        const data = (entry.payload as any)?.data
        const textHex = typeof data?.text === 'string' ? data.text : ''
        const textLen = textHex.startsWith('0x') ? (textHex.length - 2) / 2 : textHex.length / 2
        const recipientsLen = Array.isArray(data?.recipients) ? data.recipients.length * 4 : 0
        const amountsLen = Array.isArray(data?.amounts) ? data.amounts.length * 8 : 0
        return PER_ACTION_OVERHEAD + textLen + recipientsLen + amountsLen
      }

      for (let i = 0; i < remainingCandidates.length; i++) {
        const entry = remainingCandidates[i]
        const sz = entrySize(entry)

        if (bounded.length > 0 && runningSize + sz > MAX_BATCH_CALLDATA_BYTES) {
          // Would overflow. If we're mid-group, the right thing is to roll
          // back the partial group entirely (it'll be retried next poll
          // when it's the first thing in line). If THIS entry's group
          // happens to be the in-progress one, just stop here.
          if (currentGroup && currentGroup.batchId === (entry as any).batchId) {
            // Drop the partial group from `bounded`.
            bounded.length = currentGroup.startIdx
            runningSize -= currentGroup.bytes
            console.log(`[Validator] Rolling back partial batch group ${currentGroup.batchId} (${remainingCandidates.length - currentGroup.startIdx} rows) to next poll — calldata would overflow`)
          } else {
            console.log(`[Validator] Batch size limit reached at ${bounded.length} entries (~${runningSize} bytes). Deferring ${remainingCandidates.length - bounded.length} entries to next poll.`)
          }
          break
        }

        // Track group transitions so we can roll back a partial group on overflow.
        const eBatchId = (entry as any).batchId as number | null | undefined
        if (eBatchId != null) {
          if (!currentGroup || currentGroup.batchId !== eBatchId) {
            currentGroup = { batchId: eBatchId, startIdx: bounded.length, bytes: 0 }
            groupAccumulators.push(currentGroup)
          }
          currentGroup.bytes += sz
        } else {
          currentGroup = null
        }

        bounded.push(entry)
        runningSize += sz
      }

      return bounded
    }

    /** natstat: split each raw signedTx into r, s, v and collect action payloads */
    function buildMultiActionData(
      queueEntries: Array<{ payload: any; signedTx: string; batchId?: number | null }>
    ) {
      const actions: any[]    = []
      const sigParts: Array<{ v: number; r: string; s: string }> = []
      // groups[] mirrors actions[]: group[i] is the (batchId-or-tempUnique, runningGroupSize)
      // we'll fold into the grouped sigs payload below.
      const groups: Array<{ groupSize: number; v: number; r: string; s: string }> = []
      let lastBatchId: number | null | undefined = undefined

      for (const entry of queueEntries) {
        const signature = entry.signedTx
        const hex = signature.startsWith('0x') ? signature.slice(2) : signature
        const sig = {
          r: '0x' + hex.slice(0, 64),
          s: '0x' + hex.slice(64, 128),
          v: parseInt(hex.slice(128, 130), 16),
        }
        sigParts.push(sig)

        // Group adjacent txqueue rows that share a batchId. Rows with no
        // batchId always get their own group of size 1. Rows with a batchId
        // must share the SAME signedTx — the validator trusts the API to
        // have stored the batch sig consistently across the group's rows.
        if (entry.batchId != null && entry.batchId === lastBatchId && groups.length > 0) {
          groups[groups.length - 1].groupSize += 1
        } else {
          groups.push({ groupSize: 1, ...sig })
        }
        lastBatchId = entry.batchId ?? null

        // Ensure amounts are properly formatted
        const actionData = (entry.payload as any).data
        const recipients = Array.isArray(actionData.recipients) ? actionData.recipients.map(Number) : []
        const amounts = Array.isArray(actionData.amounts)
          ? actionData.amounts.map((amt: any) => {
              if (amt === null || amt === undefined || amt === '') return '0'
              const strAmt = String(amt)
              return (strAmt === 'NaN' || isNaN(Number(strAmt))) ? '0' : strAmt
            })
          : []

        // DO NOT pad amounts. The contract accepts both
        //   amounts.length == recipients.length        (no validator tip)
        // OR
        //   amounts.length == recipients.length + 1    (last amount is the tip)
        // Padding here mutates the payload AFTER the user signed it, which
        // changes the EIP-712 struct hash on-chain. ecrecover then returns
        // a random non-zero address, no session matches, and the contract
        // reverts with the misleading "Session expired or not found" — a
        // ghost bug that masqueraded as Quick-Sign expiry for any action
        // submitted with a non-canonical amounts shape (notably the early
        // poll-vote shape with recipients=[poll-author], amounts=[tip]).
        // Submit exactly what the user signed; the contract handles both
        // valid forms.

        actions.push({
          ...actionData,
          recipients,
          amounts,
        })
      }

      // Build packed format
      const packedBytes = packActions(actions.map(a => ({
        actionType: Number(a.actionType),
        senderId: Number(a.senderId),
        receiverId: Number(a.receiverId || 0),
        receiverCawonce: Number(a.receiverCawonce || 0),
        networkId: Number(a.networkId),
        cawonce: Number(a.cawonce),
        recipients: (a.recipients || []).map(Number),
        amounts: a.amounts.map((x: any) => BigInt(x)),
        text: a.text || '0x',
      })))
      const sigsBytes = packGroupedSignatures(groups)

      return {
        actions,
        v: sigParts.map(s => s.v),
        r: sigParts.map(s => s.r),
        s: sigParts.map(s => s.s),
        // Packed format for the new contract
        packedActions: bytesToHex(packedBytes),
        packedSigs: bytesToHex(sigsBytes),
      }
    }


    async function simulateActions(
      validatorId: number,
      multiData: { actions: any[]; v: number[]; r: string[]; s: string[]; packedActions: string; packedSigs: string },
      retryCount: number = 0
    ): Promise<{ successfulActions: any[], rejectionMessages: string[], quote: any }> {
      const maxRetries = 3;

      try {
        console.log(`[Attempt ${retryCount + 1}/${maxRetries}] Simulating actions with RPC: ${redactRpcUrl(l2RpcUrl)}`);
        console.log("Actions to simulate:", multiData.actions.map(a => ({
          type: getActionType(a.actionType).toString(),
          sender: a.senderId,
          cawonce: a.cawonce
        })));

        // Get withdrawal quote if there are any withdrawals
        console.log("[Validator] Step 1: Checking for withdrawals...")
        const withdraws = multiData.actions.filter((action: any) => getActionType(action.actionType).toString() === 'WITHDRAW')
        let withdrawQuote = { nativeFee: BigInt(0), lzTokenFee: BigInt(0) }
        console.log(`[Validator] Found ${withdraws.length} withdrawal actions`)
        if (withdraws.length > 0) {
          const tokenIds = withdraws.map((action: any) => action.senderId)
          // Convert amounts from whole CAW units to wei (action struct uses uint64, so amounts are not in wei)
          const amounts = withdraws.map((action: any) => BigInt(action.amounts[0]) * 10n**18n)
          console.log("[Validator] Getting withdraw quote for tokenIds:", tokenIds, "amounts (in wei):", amounts)
          try {
            // Add timeout to withdrawQuote call
            const quotePromise = cawActions.withdrawQuote(tokenIds, amounts, false)
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error('withdrawQuote timeout after 10s')), 10000)
            })
            withdrawQuote = await Promise.race([quotePromise, timeoutPromise]) as any
            console.log('[Validator] Withdraw quote:', withdrawQuote)
            // Seed the cache so a downstream recalculateQuoteForActions
            // for an identical-withdrawals sub-batch reuses the quote
            // instead of issuing a second eth_call.
            const cacheKey = tokenIds.map((t: any, i: number) => `${t}:${amounts[i].toString()}`).sort().join(',')
            withdrawQuoteCache.set(cacheKey, { quote: withdrawQuote, cachedAt: Date.now() })
          } catch (err: any) {
            console.error("[Validator] Failed to get withdraw quote:", err.message || err)
          }
        }

        // Build the quote object (withdraw fees only — replication is handled separately)
        const quote = {
          nativeFee: BigInt(withdrawQuote.nativeFee || 0),
          withdrawFee: BigInt(withdrawQuote.nativeFee || 0),
          withdrawLzTokenAmount: BigInt(withdrawQuote.lzTokenFee || 0),
        }

        console.log("[Validator] Step 2: Building quote object...")
        console.log("[Validator] Total fees:", {
          withdrawFee: quote.withdrawFee.toString(),
          totalNativeFee: quote.nativeFee.toString()
        })

        // ABI‐encode with the 4-argument signature (replication is handled separately)
        console.log("[Validator] Step 3: Encoding calldata...")
        let calldata: string
        try {
          calldata = packedIface.encodeFunctionData('safeProcessActions', [
            validatorId,
            multiData.packedActions,
            multiData.packedSigs,
            quote.withdrawFee,
            quote.withdrawLzTokenAmount,
          ])
          console.log(`[Validator] Calldata encoded successfully (${calldata.length} chars)`)
        } catch (encodeErr: any) {
          console.error(`[Validator] FAILED to encode calldata:`, encodeErr.message)
          throw encodeErr
        }
        console.log(`Calldata prepared, simulating transaction...`)
        console.log(`  - Contract: ${CAW_ACTIONS_ADDRESS}`)
        console.log(`  - Value: ${quote?.nativeFee?.toString() || '0'}`)
        console.log(`  - Actions: ${multiData.actions.length}`)
        console.log(`  - Action details:`, multiData.actions.map(a => ({
          type: getActionType(a.actionType).toString(),
          senderId: a.senderId,
          receiverId: a.receiverId,
          cawonce: a.cawonce
        })))

        console.log("[Validator] Step 5: Making RPC call...")
        const startTime = Date.now();

        // Use the HTTP provider for simulation — WSS hangs on large eth_call
        // payloads (50+ actions worth of calldata saturates the socket).
        console.log(`[Validator] Calling httpProvider.call() to ${CAW_ACTIONS_ADDRESS} with value ${quote?.nativeFee?.toString() || '0'}`)
        const callPromise = httpProvider.call({
          to: CAW_ACTIONS_ADDRESS,
          data: calldata,
          value: quote?.nativeFee
        })

        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('RPC call timeout after 30 seconds')), 30000)
        })

        let returnData: string
        try {
          console.log("[Validator] Awaiting RPC response (30s timeout)...")
          returnData = await Promise.race([callPromise, timeoutPromise]) as string
          console.log(`[Validator] RPC call returned data (${returnData?.length || 0} chars)`)
        } catch (timeoutErr: any) {
          console.error('[Validator] RPC call timeout or error:', timeoutErr.message)
          console.error('[Validator] Full timeout error:', timeoutErr)
          // No WSS reinit needed — we're on HTTP now, each request is independent.
          throw timeoutErr
        }

        const elapsed = Date.now() - startTime;

        console.log(`[Validator] Step 6: Decoding response...`)
        console.log(`Simulation completed in ${elapsed}ms`)
        const decoded = packedIface.decodeFunctionResult(
          'safeProcessActions',
          returnData
        ) as [ bigint, string[] ]  // [ successCount, rejectionMessages ]
        console.log("decoded", decoded)

        const [ successCount, rejectionMessages ] = decoded
        // Build a minimal successfulActions array from the non-rejected entries
        const successfulActions = multiData.actions.filter((_: any, i: number) => !rejectionMessages[i])

        console.log("simulated:", Number(successCount), rejectionMessages)
        console.log("[Validator] Simulation results:")
        console.log(`  - Successful actions: ${successfulActions.length}`)
        if (successfulActions.length > 0) {
          console.log("  - Successful action details:", successfulActions.map((action: any, i: number) => ({
            index: i,
            type: getActionType(action.actionType).toString(),
            sender: action.senderId,
            receiver: action.receiverId,
            cawonce: action.cawonce,
            amounts: action.amounts?.map((a: any) => a.toString())
          })))
        }
        if (rejectionMessages.length > 0) {
          console.log(`  - Rejected actions: ${rejectionMessages.length}`)
          rejectionMessages.forEach((msg: string, i: number) => {
            if (msg) console.log(`    [${i}] Rejection reason: ${msg}`)
          })
        }
        return { successfulActions, rejectionMessages, quote }
      } catch (err: any) {
        // Log full error details
        console.error(`[Attempt ${retryCount + 1}] Simulation failed:`, {
          error: err.message || String(err),
          code: err.code,
          rpcUrl: redactRpcUrl(l2RpcUrl),
          actions: multiData.actions.map(a => ({
            type: getActionType(a.actionType).toString(),
            sender: a.senderId,
            cawonce: a.cawonce
          }))
        });

        // Handle specific blockchain errors (these don't need retry)
        if (err.message?.includes('execution reverted')) {
          const revertMatch = err.message.match(/execution reverted: (.+)/);
          const revertReason = revertMatch?.[1] || err.message;
          console.log(`Execution reverted with reason: ${revertReason}`);

          // Check for specific duplicate cawonce error
          if (revertReason.includes('cawonce') || revertReason.includes('already processed')) {
            const rejectionMessages = multiData.actions.map(() =>
              `Transaction already processed - duplicate cawonce`
            );
            return { successfulActions: [], rejectionMessages, quote: { nativeFee: BigInt(0) } };
          }

          const rejectionMessages = multiData.actions.map(() =>
            `Transaction reverted: ${revertReason}`
          );
          return { successfulActions: [], rejectionMessages, quote: { nativeFee: BigInt(0) } };
        }

        // Handle timeout errors - mark as temporary failure, don't mark as failed
        if (err.message?.includes('timeout')) {
          console.log('[Validator] RPC timeout detected - will retry on next poll')
          const rejectionMessages = multiData.actions.map(() =>
            'RPC timeout - will retry'
          );
          return { successfulActions: [], rejectionMessages, quote: { nativeFee: BigInt(0) } };
        }

        // Handle provider/network errors. In no-WS mode the provider IS
        // httpProvider; once destroyed, every cawActions.* call funnels
        // through it and throws — we have to swap the underlying provider,
        // not just rebind. rebuildHttpProvider does that. WS mode can
        // continue to use the WS-aware initializeConnection path.
        if (err.message?.includes('provider destroyed') ||
            err.message?.includes('UNSUPPORTED_OPERATION') ||
            err.message?.includes('cancelled request') ||
            err.code === 'UNSUPPORTED_OPERATION') {
          if (USE_WS) {
            console.log('[Validator] Provider/network error detected - reinitializing WS connection')
            initializeConnection()
          } else {
            rebuildHttpProvider(`error in simulation: ${err.message ?? err.code}`)
          }
          const rejectionMessages = multiData.actions.map(() =>
            'Network error - will retry'
          );
          return { successfulActions: [], rejectionMessages, quote: { nativeFee: BigInt(0) } };
        }

        // Handle other errors
        const rejectionMessages = multiData.actions.map(() => {
          if (err.message?.includes('insufficient funds')) {
            return 'Insufficient funds for transaction';
          } else if (err.message?.includes('nonce')) {
            return 'Invalid nonce - transaction may be outdated';
          } else if (err.message?.includes('already known')) {
            return 'Transaction already known - duplicate cawonce';
          } else {
            return `Simulation error: ${err.message || 'Unknown error'}`;
          }
        });

        return { successfulActions: [], rejectionMessages, quote: { nativeFee: BigInt(0) } };
      }
    }

    async function estimateProcessGasCost(
      validatorId: number,
      multiData: { actions: any[]; v: number[]; r: string[]; s: string[]; packedActions: string; packedSigs: string },
      quote: { nativeFee: bigint; withdrawFee: bigint; withdrawLzTokenAmount: bigint }
    ) {
      // Calculate gas cost from action count instead of estimateGas.
      // Infura's estimateGas fails with "missing revert data" on large calldata
      // even when eth_call succeeds. ~50K gas/action + 100K base, 30% buffer.
      const actionCount = multiData.actions.length
      const calculatedGas = BigInt(Math.ceil((100_000 + actionCount * 50_000) * 1.3))

      const feeData = await httpProvider.getFeeData()
      const gasPrice = feeData.gasPrice ?? BigInt(0)

      return calculatedGas * gasPrice;
    }


    /** natstat: estimate the raw gas‐limit for processActions */
    async function estimateGasLimit(
      validatorId: number,
      multiData: { actions: any[]; v: number[]; r: string[]; s: string[]; packedActions: string; packedSigs: string },
      quote: { nativeFee: bigint; withdrawFee: bigint; withdrawLzTokenAmount: bigint }
    ): Promise<bigint> {
      // Peek at the ZK cache (don't consume here — the actual submit happens
      // later in submitProcessActions). The estimate just needs to know which
      // path we'll take so the gas budget is right.
      const { isZk } = encodeProcessActionsCalldata(validatorId, multiData, quote, { consume: false });

      // Calculate gas limit from action count instead of estimateGas.
      // Infura's estimateGas fails with "missing revert data" on large calldata
      // even when eth_call succeeds. Sig path: ~50K gas/action + 100K base.
      // ZK path: ~300K verifier + 30K/action + 100K base (verifier dominates
      // at small batches, per-action cost is lower because no in-EVM ecrecover).
      const actionCount = multiData.actions.length
      const base = isZk ? 400_000 : 100_000
      const perAction = isZk ? 30_000 : 50_000
      return BigInt(Math.ceil((base + actionCount * perAction) * 1.3));
    }


    // Serializes the nonce-fetch-and-send section of submitProcessActions
    // so two parallel sub-batch submissions don't both read the same `pending`
    // nonce and submit colliding txs. The contract's onchain logic and the
    // retry path at line ~1503 already recover from a nonce collision, but
    // serializing here saves the wasted gas + delay of REPLACEMENT_UNDERPRICED
    // retries when many clients are processing in parallel. Audit fix
    // 2026-05-13.
    let _submitChain: Promise<unknown> = Promise.resolve()

    async function submitProcessActions(
      validatorId: number,
      multiData: { actions: any[]; v: number[]; r: string[]; s: string[]; packedActions: string; packedSigs: string },
      quote: { nativeFee: bigint; withdrawFee: bigint; withdrawLzTokenAmount: bigint },
      rawGasLimit: bigint,
      retryCount: number = 0
    ) {
      const maxRetries = 3
      const gasBumpPercent = 15 // Increase gas by 15% on each retry

      // Wait until any prior submission has at least read its nonce and
      // submitted. We don't wait for the receipt — that would unnecessarily
      // serialize all on-chain confirmation latency. Just the "fetch nonce
      // → sendTransaction" race is what we're fixing.
      const prev = _submitChain
      let releaseSlot: () => void = () => {}
      _submitChain = new Promise<void>(resolve => { releaseSlot = resolve })
      try {
        await prev
      } catch { /* prior failed — fine, continue */ }

      const feeData = await httpProvider.getFeeData();

      // Pre-fetch nonce so sendTransaction doesn't need to (throttle handles spacing)
      const nonce = await httpProvider.getTransactionCount(signer.getAddress(), 'pending')

      // Bump gas fees on retry to handle REPLACEMENT_UNDERPRICED errors
      let maxFeePerGas = feeData.maxFeePerGas ?? BigInt(0)
      let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? BigInt(0)

      if (retryCount > 0) {
        const multiplier = BigInt(100 + (gasBumpPercent * retryCount))
        maxFeePerGas = (maxFeePerGas * multiplier) / BigInt(100)
        maxPriorityFeePerGas = (maxPriorityFeePerGas * multiplier) / BigInt(100)
        console.log(`[submitProcessActions] Retry ${retryCount}/${maxRetries}, bumped gas by ${gasBumpPercent * retryCount}%`)
      }

      try {
        // Encode calldata. Picks the ZK path when ZK_PROVER_ENABLED=1 AND a
        // proof is staged for this exact tuple; otherwise sig path. The proof
        // is consumed here (single-use) so a retry doesn't accidentally reuse
        // a stale proof — retries fall back to sig path automatically.
        const { calldata: txData, isZk } = encodeProcessActionsCalldata(
          validatorId,
          multiData,
          quote,
          { consume: true },
        )

        if (!txData || txData === '0x' || txData.length < 10) {
          console.error('[submitProcessActions] CRITICAL: encodeFunctionData returned empty/invalid data:', {
            txData,
            validatorId,
            actionsCount: multiData.actions.length,
            withdrawFee: quote.withdrawFee.toString(),
            withdrawLzTokenAmount: quote.withdrawLzTokenAmount.toString(),
          })
          throw new Error(`encodeFunctionData produced invalid calldata: "${txData}"`)
        }
        if (isZk) {
          console.log(`[submitProcessActions] ZK path: ${multiData.actions.length} action(s) with staged proof`)
        }

        // All params pre-populated so ethers makes exactly 1 RPC call (eth_sendRawTransaction)
        const tx = await signer.asEthersSigner().sendTransaction({
          to:    CAW_ACTIONS_ADDRESS,
          data:  txData,
          value: quote.nativeFee,
          nonce,
          gasLimit: rawGasLimit,
          maxFeePerGas,
          maxPriorityFeePerGas,
          chainId: 84532,
          type: 2,
        })
        // Submission is in the mempool — release the nonce-serialization
        // slot so the next caller can fetch its own nonce. We don't wait
        // for tx confirmation here, which would needlessly block parallel
        // submissions on chain latency.
        releaseSlot()
        console.log(`[submitProcessActions] Sent ${multiData.actions.length} action(s), tx=${tx.hash}`)

        const receipt = await tx.wait()

        // ActionsProcessed / ActionsProcessedZk are now calldata commitments
        // (event carries batchHash + counts; the packedActions blob lives in
        // tx.input). We don't need to fetch bytes back from the event because
        // we already have them in scope as multiData.packedActions, but we
        // still parse the log to confirm the contract emitted it and to read
        // the ZK actionsExecutedBitmap when present.
        const evt = receipt?.logs
          ?.map(log => { try { return iface.parseLog(log) } catch { return null } })
          ?.find(x => x?.name === 'ActionsProcessed' || x?.name === 'ActionsProcessedZk')

        if (!evt) {
          console.error("[submitProcessActions] ActionsProcessed[Zk] event missing from receipt!")
          console.error("[submitProcessActions] Receipt logs:", receipt?.logs)
          throw new Error('ActionsProcessed event missing')
        }

        // Decode packed bytes from the local multiData we just submitted —
        // the source of truth, identical to what's in tx.input.
        const packedHex = multiData.packedActions
        const packedBuf = new Uint8Array((packedHex.startsWith('0x') ? packedHex.slice(2) : packedHex).match(/.{2}/g)!.map(b => parseInt(b, 16)))
        const decoded = unpackActions(packedBuf)

        // ZK path: filter by actionsExecutedBitmap. A 0 bit means the action
        // was skip-don't-revert'd (e.g. cawonce already used by a competing
        // sig-path tx). Only the executed actions should flow downstream as
        // 'processed' — the others will be retried via the normal lifecycle.
        const bitmap: bigint = evt.name === 'ActionsProcessedZk'
          ? BigInt(evt.args.actionsExecutedBitmap?.toString() ?? '0')
          : ((1n << BigInt(decoded.length)) - 1n)
        const processed = decoded
          .map((a, i) => ({ a, executed: (bitmap & (1n << BigInt(i))) !== 0n }))
          .filter(x => x.executed)
          .map(x => ({
            senderId: Number(x.a.senderId),
            cawonce:  Number(x.a.cawonce),
          }))
        const skipped = decoded.length - processed.length
        const skipNote = skipped > 0 ? ` [zk-skipped ${skipped}]` : ''
        console.log(`[submitProcessActions] Confirmed in block ${receipt?.blockNumber} (${processed.length} action(s))${skipNote}`)
        return { processed, receipt }
      } catch (err: any) {
        // Handle "oversized data" — tx calldata exceeds the 128KB protocol limit.
        // Split the batch in half and try again. Uses recursion with a shrinking
        // multiData so at worst we end up submitting one action at a time.
        if (err.message?.includes('oversized data') && multiData.actions.length > 1) {
          const halfLen = Math.floor(multiData.actions.length / 2)
          console.warn(`[submitProcessActions] Oversized tx (${multiData.actions.length} actions). Splitting in half — sending first ${halfLen}, deferring the rest.`)
          const firstHalf = {
            actions: multiData.actions.slice(0, halfLen),
            v: multiData.v.slice(0, halfLen),
            r: multiData.r.slice(0, halfLen),
            s: multiData.s.slice(0, halfLen),
          }
          // Note: quote was computed for the full batch. The withdraw-related
          // portion should still be ≥ what we need for this smaller batch.
          return submitProcessActions(validatorId, firstHalf, quote, rawGasLimit, 0)
        }

        // Handle REPLACEMENT_UNDERPRICED - retry with higher gas
        if (err.code === 'REPLACEMENT_UNDERPRICED' || err.message?.includes('replacement transaction underpriced')) {
          if (retryCount < maxRetries) {
            console.log(`[submitProcessActions] REPLACEMENT_UNDERPRICED error - retrying with higher gas (attempt ${retryCount + 1}/${maxRetries})`)
            // Wait a moment for the mempool to update
            await new Promise(resolve => setTimeout(resolve, 1000))
            return submitProcessActions(validatorId, multiData, quote, rawGasLimit, retryCount + 1)
          } else {
            console.error(`[submitProcessActions] Max retries (${maxRetries}) exceeded for REPLACEMENT_UNDERPRICED error`)
          }
        }

        // Handle "already known" - transaction is already in mempool, wait for it
        if (err.code === 'ALREADY_KNOWN' || err.message?.includes('already known')) {
          console.log('[submitProcessActions] Transaction already known in mempool - waiting for confirmation...')
          // Wait and check if it gets mined
          await new Promise(resolve => setTimeout(resolve, 5000))
          // The transaction might have been mined by now, but we can't track it without the hash
          // Just propagate the error and let it retry on next poll
        }

        // Handle nonce issues - get fresh nonce and retry
        if (err.message?.includes('nonce') && retryCount < maxRetries) {
          console.log(`[submitProcessActions] Nonce issue detected - waiting and retrying (attempt ${retryCount + 1}/${maxRetries})`)
          await new Promise(resolve => setTimeout(resolve, 2000))
          return submitProcessActions(validatorId, multiData, quote, rawGasLimit, retryCount + 1)
        }

        // Handle transient RPC/network errors - retry with backoff
        const isTransient = err.code === 'UNKNOWN_ERROR' ||
          err.code === 'SERVER_ERROR' ||
          err.code === 'TIMEOUT' ||
          err.code === 'NETWORK_ERROR' ||
          err.message?.includes('error sending request') ||
          err.message?.includes('could not coalesce') ||
          err.message?.includes('ECONNREFUSED') ||
          err.message?.includes('ETIMEDOUT') ||
          err.message?.includes('fetch failed') ||
          err.message?.includes('network error')

        if (isTransient && retryCount < maxRetries) {
          const delay = Math.min(2000 * (retryCount + 1), 10000)
          console.log(`[submitProcessActions] Transient RPC error - retrying in ${delay}ms (attempt ${retryCount + 1}/${maxRetries}): ${err.message?.substring(0, 100)}`)
          await new Promise(resolve => setTimeout(resolve, delay))
          return submitProcessActions(validatorId, multiData, quote, rawGasLimit, retryCount + 1)
        }

        throw err
      } finally {
        // Always release the nonce-serialization slot, even if sendTransaction
        // threw before we reached the success-path release above. Idempotent —
        // resolving an already-resolved promise is a no-op.
        releaseSlot()
      }
    }

    // Recovery for batch tx reverts that aren't transient. Two cases:
    //   (a) Mirror race: re-simulation flags one or more cawonces as used.
    //       Mark those failed; reset the rest to pending so the next poll
    //       retries them in a fresh batch.
    //   (b) Sim-passes-but-tx-reverts (e.g. underestimated LayerZero fee):
    //       re-sim still says all-good. Bisect the entry list, re-quoting
    //       and re-estimating gas per sub-batch, until each reverter is
    //       isolated to a single-action submission and fails alone.
    // Returns true if every entry in `entries` got a verdict written into
    // `verdictByEntryId`. Returns false if it bailed out (transient error
    // mid-recovery, etc.) so the caller can fall back to mark-all-failed.
    async function recoverBatchFailure(
      validatorId: number,
      entries: any[],
      originalRevertReason: string,
      verdictByEntryId: Map<number, { succeeded: true } | { succeeded: false; reason: string } | { pending: true }>,
      finalizedOut: any[],
    ): Promise<boolean> {
      console.log(`[Validator/recovery] Starting recovery for ${entries.length} entries; original revert: ${originalRevertReason.slice(0, 200)}`)

      // Stage 1: re-simulate to catch mirror races. Cheap (one eth_call).
      const reSimMulti = buildMultiActionData(entries)
      let reSimResult: { successfulActions: any[]; rejectionMessages: string[]; quote: any }
      try {
        reSimResult = await simulateActions(validatorId, reSimMulti)
      } catch (err: any) {
        console.error('[Validator/recovery] Re-simulation threw — bailing recovery:', err.message)
        return false
      }
      const reSimRejections = reSimResult.rejectionMessages || []
      const anyNewRejections = reSimRejections.some((m: string) => m && m.length > 0)

      if (anyNewRejections) {
        // Mirror race (or stale state). Mark rejected entries failed; reset
        // the rest to pending so they get a fresh batch on the next poll.
        let failed = 0, pending = 0
        entries.forEach((entry, i) => {
          const reason = reSimRejections[i]
          if (reason && reason.length > 0) {
            verdictByEntryId.set(entry.id, { succeeded: false, reason })
            failed++
          } else {
            verdictByEntryId.set(entry.id, { pending: true })
            pending++
          }
        })
        console.log(`[Validator/recovery] Re-sim flagged ${failed} entries — marked failed, ${pending} reset to pending`)
        return true
      }

      // Stage 2: re-sim still says all-good but the real tx reverted.
      // Bisect to isolate the bad action(s).
      console.log('[Validator/recovery] Re-sim still passes — bisecting to isolate the reverter(s)')
      try {
        await bisectAndSubmit(validatorId, entries, originalRevertReason, verdictByEntryId, finalizedOut, 0)
      } catch (bisectErr: any) {
        if (bisectErr?.name === 'BisectTransientError') {
          // RPC blip mid-bisect — keep what we already proved (succeeded
          // sub-batches in finalizedOut already have verdicts) and reset
          // the rest to pending so the next poll picks them up fresh.
          // Net effect: zero rows misclassified as "Bisected revert" on
          // an RPC outage.
          let resetCount = 0
          for (const entry of entries) {
            if (!verdictByEntryId.has(entry.id)) {
              verdictByEntryId.set(entry.id, { pending: true })
              resetCount++
            }
          }
          console.warn(`[Validator/recovery] Bisect aborted on transient RPC error — ${resetCount} entries reset to pending: ${bisectErr.cause?.message || bisectErr.message}`)
          return true // verdicts populated; outer path honors them and skips mark-all-failed
        }
        throw bisectErr
      }
      // Any entry without a verdict at this point means bisection bailed out
      // before reaching it — caller's fallback will mark them failed.
      const missing = entries.filter(e => !verdictByEntryId.has(e.id))
      if (missing.length > 0) {
        console.warn(`[Validator/recovery] ${missing.length} entries unresolved after bisection`)
        return false
      }
      return true
    }

    // Recognize errors that mean "RPC blip, not a contract revert". We must
    // never mark TxQueue rows failed for these — keep them pending so the
    // next poll retries.  Mirrors the gate at the submission catch around
    // line 2100; any change there should be reflected here.
    function isTransientRpcError(err: any): boolean {
      const msg = (err?.message || '').toLowerCase()
      return (
        err?.code === 'UNSUPPORTED_OPERATION' ||
        err?.code === 'BAD_DATA' ||
        err?.code === 'UNKNOWN_ERROR' ||
        msg.includes('provider destroyed') ||
        msg.includes('cancelled request') ||
        msg.includes('too many requests') ||
        msg.includes('429') ||
        msg.includes('rate limit') ||
        msg.includes('missing response') ||
        msg.includes('internal error') ||
        msg.includes('could not coalesce') ||
        msg.includes('timeout') ||
        msg.includes('enotfound') ||
        msg.includes('econnrefused') ||
        msg.includes('econnreset')
      )
    }

    // Sentinel thrown out of bisectAndSubmit when an RPC error (rather than
    // a real action revert) interrupts the recovery. recoverBatchFailure
    // catches this, marks every still-undecided entry `pending`, and
    // returns true so the outer submission path doesn't mark-all-failed.
    class BisectTransientError extends Error {
      constructor(public readonly cause: any) {
        super(`Bisect aborted on transient RPC error: ${cause?.message || cause}`)
        this.name = 'BisectTransientError'
      }
    }

    // Recursive bisection. On revert with len > 1: split, recurse on each
    // half (re-quoting + re-estimating gas per sub-batch). On revert with
    // len == 1: that single action is the reverter — mark it failed.
    // Successful submissions append to finalizedOut and write succeeded
    // verdicts. Bounded by Math.ceil(log2(N)) recursion depth.
    //
    // Throws BisectTransientError when ANY step (quote, gas estimate, or
    // submit) fails with an RPC-class error. Without that distinction we'd
    // mark innocent rows permanently failed during a flaky-RPC window.
    async function bisectAndSubmit(
      validatorId: number,
      entries: any[],
      lastRevertReason: string,
      verdictByEntryId: Map<number, { succeeded: true } | { succeeded: false; reason: string } | { pending: true }>,
      finalizedOut: any[],
      depth: number,
    ): Promise<void> {
      const indent = '  '.repeat(depth)
      console.log(`[Validator/bisect]${indent} depth=${depth} trying ${entries.length} action(s)`)

      if (entries.length === 0) return

      // Re-build calldata + re-quote for *this* sub-batch (withdraw set may
      // differ). Quote/gas estimation are eth_calls and can hit transient
      // RPC errors — wrap them in the same try so we treat those as
      // transients rather than as bisect-level reverts.
      try {
        const subMulti = buildMultiActionData(entries)
        const subQuote = await recalculateQuoteForActions(subMulti)
        const subGasLimit = await estimateGasLimit(validatorId, subMulti, subQuote)

        const { processed } = await submitProcessActions(validatorId, subMulti, subQuote, subGasLimit)
        // Sub-batch landed. Mark its entries succeeded based on what the
        // contract actually emitted.
        for (const entry of entries) {
          const data = (entry.payload as any).data
          const landed = processed.some(
            (p: any) => p.senderId === data.senderId && p.cawonce === data.cawonce
          )
          if (landed) {
            verdictByEntryId.set(entry.id, { succeeded: true })
          } else {
            verdictByEntryId.set(entry.id, { succeeded: false, reason: 'Action missing from ActionsProcessed event' })
          }
        }
        finalizedOut.push(...processed)
        console.log(`[Validator/bisect]${indent} ✓ ${processed.length}/${entries.length} action(s) landed`)
        return
      } catch (subErr: any) {
        // RPC blip during bisect: bubble out so recoverBatchFailure can
        // mark everything still-undecided as pending. Re-throwing instead
        // of returning means siblings further up the recursion don't keep
        // running (and don't waste gas + risk wedging on the same blip).
        if (isTransientRpcError(subErr)) {
          throw new BisectTransientError(subErr)
        }
        const subReason = subErr.message || lastRevertReason
        if (entries.length === 1) {
          // Terminal: this single action is the reverter.
          const entry = entries[0]
          verdictByEntryId.set(entry.id, { succeeded: false, reason: `Bisected revert: ${subReason}` })
          console.warn(`[Validator/bisect]${indent} ✗ isolated reverter: TxQueue #${entry.id} (${subReason.slice(0, 120)})`)
          return
        }
        // Split in half and recurse on each.
        const mid = Math.floor(entries.length / 2)
        const left = entries.slice(0, mid)
        const right = entries.slice(mid)
        console.log(`[Validator/bisect]${indent} ✗ revert at len=${entries.length}, splitting ${left.length} | ${right.length}`)
        await bisectAndSubmit(validatorId, left, subReason, verdictByEntryId, finalizedOut, depth + 1)
        await bisectAndSubmit(validatorId, right, subReason, verdictByEntryId, finalizedOut, depth + 1)
      }
    }

    /**
     * Check if a failed action should wait for a pending deposit instead of failing.
     * Returns 'waiting_for_deposit' if the user has a recent deposit in flight, or 'failed' otherwise.
     */
    // Deposit hold is now driven by TxQueue.pendingDepositTxHash (set by the
    // client at submission time) and the DataCleaner L2 watcher. This function
    // is no longer used — kept as a stub in case a code path still references it.
    async function checkDepositWaiting(_senderId: number, rejection: string): Promise<{ status: string; reason: string }> {
      return { status: 'failed', reason: rejection }
    }

    /** natstat: update each queue entry to done/failed based on simulation + submission */
    async function updateQueueStatuses(
      queueEntries: Array<{ id: number; payload: any }>,
      simulatedGood: Array<{ senderId: number; cawonce: number }>,
      simulationRejections: string[]
    ) {
console.log("Update success")
      const succeededKeys = new Set(
        simulatedGood.map(a => `${a.senderId}-${a.cawonce}`)
      )
console.log("succeededKeys", succeededKeys)

      await Promise.all(queueEntries.map(async (entry: any, index) => {
        const data = (entry.payload as any).data
        const key  = `${data.senderId}-${data.cawonce}`

        // Check "Cawonce already used" — verify in Action table before
        // marking done. If the Action row hasn't been indexed yet, defer
        // (status: awaiting_indexer) and we'll recheck on the next tick.
        const rejection = simulationRejections[index] || ''
        const cawonceUsed = rejection.includes('Cawonce already used')
        let cawonceResolution: 'done' | 'failed' | 'awaiting_indexer' | null = null
        if (cawonceUsed) {
          cawonceResolution = await resolveCawonceUsed(data, entry.updatedAt, httpProvider)
          if (cawonceResolution === 'failed') {
            console.log(`[Validator] TxQueue ${entry.id}: Cawonce ${data.cawonce} used by DIFFERENT action — marking failed`)
          } else if (cawonceResolution === 'awaiting_indexer') {
            console.log(`[Validator] TxQueue ${entry.id}: Cawonce ${data.cawonce} reported used but Action row not yet indexed — deferring`)
          }
        }

        const processedByOther = cawonceResolution === 'done'

        let newStatus: string = succeededKeys.has(key) || processedByOther
          ? 'done'
          : cawonceResolution === 'awaiting_indexer'
            ? 'awaiting_indexer'
            : 'failed'

        // Get the rejection reason for this specific entry
        let reason: string | undefined =
          newStatus === 'failed' && simulationRejections[index]
            ? (cawonceUsed && !processedByOther ? 'Cawonce already used' : simulationRejections[index])
            : undefined

        // Check if the failure is due to insufficient balance with a pending deposit
        if (newStatus === 'failed' && reason) {
          const depositCheck = await checkDepositWaiting(data.senderId, reason)
          newStatus = depositCheck.status
          reason = depositCheck.reason
        }

        console.log("new status", newStatus, reason ? `with reason: ${reason}` : '')

        if (newStatus === 'failed' && reason) {
          await markTxQueueFailed(entry.id, reason, data.senderId, data)
        } else if (newStatus === 'awaiting_indexer') {
          // Don't surface this to the user as a failure; just bump the row
          // so updatedAt advances and the next pass will see how long
          // we've been waiting.
          await prisma.txQueue.update({
            where: { id: entry.id },
            data: { status: 'awaiting_indexer', reason: 'awaiting Action indexer' },
          })
        } else {
          // 'done' path (or non-terminal states like waiting_for_deposit).
          // No notification needed — the helper is only for terminal failures.
          await prisma.txQueue.update({
            where: { id: entry.id },
            data: { status: newStatus, ...(reason ? { reason } : {}) }
          })
        }

        // Failure cleanup (Caw FAILED, Follow FAILED, Like delete, etc) now
        // lives in markTxQueueFailed -> cleanupOptimisticRows. We only need
        // to handle the success-side transition below.
        if (newStatus === 'done' && (data.actionType === 0 || data.actionType === 'caw' || data.actionType === 3 || data.actionType === 'recaw')) {
          // If succeeded, mark as SUCCESS
          // Note: Hashtags are processed by ActionProcessor when it receives the on-chain event
          try {
            await prisma.caw.update({
              where: {
                userId_cawonce: {
                  userId: data.senderId,
                  cawonce: data.cawonce
                }
              },
              data: {
                status: 'SUCCESS'
              }
            })
            console.log(`Marked caw as SUCCESS for user ${data.senderId} cawonce ${data.cawonce}`)
          } catch (cawUpdateErr) {
            console.error('Failed to update caw status to SUCCESS:', cawUpdateErr)
            // Continue even if caw update fails (might not exist)
          }
        }
      }))
    }

    function computeTotalTip(
      entries: Array<{ payload: any }>
    ): bigint {
      return entries.reduce((sum, e) => {
        const amounts = (e.payload as any).data.amounts as string[]
        const lastAmt = amounts[amounts.length - 1] ?? '0'
        return sum + BigInt(lastAmt)
      }, BigInt(0))
    }

    /**
     * Recalculate quote for a specific set of actions
     * Used after filtering to succeeded actions to get accurate fees.
     *
     * Process-local cache keyed by (sorted tokenIds, sorted amounts) —
     * when the bisect path produces a sub-batch whose withdrawal set is
     * identical to the parent's (the common case: no failures in
     * withdrawals), we reuse the parent's quote instead of issuing a
     * second eth_call to withdrawQuote(). cache entries are short-lived
     * (cleared every minute) to avoid stale fees if LZ pricing moves.
     */
    async function recalculateQuoteForActions(
      multiData: { actions: any[]; v: number[]; r: string[]; s: string[]; packedActions: string; packedSigs: string }
    ): Promise<{ nativeFee: bigint; withdrawFee: bigint; withdrawLzTokenAmount: bigint }> {
      // Get withdrawal quote
      const withdraws = multiData.actions.filter((action: any) => getActionType(action.actionType).toString() === 'WITHDRAW')
      let withdrawQuote = { nativeFee: BigInt(0), lzTokenFee: BigInt(0) }
      if (withdraws.length > 0) {
        const tokenIds = withdraws.map((action: any) => action.senderId)
        const amounts = withdraws.map((action: any) => BigInt(action.amounts[0]) * 10n**18n)
        const cacheKey = tokenIds.map((t: any, i: number) => `${t}:${amounts[i].toString()}`).sort().join(',')
        const cached = withdrawQuoteCache.get(cacheKey)
        if (cached && Date.now() - cached.cachedAt < 60_000) {
          withdrawQuote = cached.quote
        } else {
          try {
            withdrawQuote = await cawActions.withdrawQuote(tokenIds, amounts, false) as any
            withdrawQuoteCache.set(cacheKey, { quote: withdrawQuote, cachedAt: Date.now() })
          } catch (err) {
            console.error("[Validator] Failed to get withdraw quote:", err)
          }
        }
      }

      return {
        nativeFee: BigInt(withdrawQuote.nativeFee || 0),
        withdrawFee: BigInt(withdrawQuote.nativeFee || 0),
        withdrawLzTokenAmount: BigInt(withdrawQuote.lzTokenFee || 0),
      }
    }

    /** natstat: check if OTHER actions have sufficient CAW payment for their content */
    async function validateOtherActionCost(
      action: any
    ): Promise<{ valid: boolean; requiredCaw?: number; underpriced?: boolean }> {
      // Check if this is an 'other' action type
      if (getActionType(action.actionType).toString() !== 'OTHER') {
        return { valid: true }
      }

      const text = action.text || ''

      // Check if this is a profile update (p: prefix or profile-update: prefix)
      if (text.startsWith('p:') || text.startsWith('profile-update:')) {
        // Profile updates have their cost calculated on frontend
        // We just need to check if sufficient tip was provided
        const amounts = action.amounts || []
        const providedTip = amounts.length > 0 ? Number(amounts[0]) : 0

        // Profile updates should have some tip amount for the cost
        if (providedTip < 100) { // Minimum 100 CAW for profile updates
          console.log(`Profile update has insufficient tip: ${providedTip} CAW`)
          return { valid: false, requiredCaw: 100, underpriced: true }
        }
        return { valid: true }
      }

      return { valid: true }
    }


    /** natstat: core polling loop */
    async function pollLoop() {
      await refreshSettings(checkInterval)
      // Cheap metric — one max(createdAt) query — so resolveCawonceUsed
      // can size its budget to the indexer's actual lag rather than a
      // static wall.
      await refreshIndexerLag()
      // Track every row we mark 'processing' in this poll so the outer catch
      // can roll them back to 'pending' on failure. Without this, an RPC
      // hang anywhere downstream leaves rows stuck in 'processing' until the
      // next poll's 30s stale-sweep rescues them — which loses work
      // proportional to RPC failure rate when the L2 endpoint is flaky.
      // We don't reset rows that the loop has already moved past 'processing'
      // into a terminal state (done/failed/underpriced/awaiting_indexer);
      // the WHERE clause guards that.
      const markedAsProcessing: number[] = []
      try {
        const entries = await fetchPendingQueue()
        if (!entries.length) return

        // Priority lane: if any queued action has a tip >= priorityTip, skip the batch wait
        // and process immediately. This rewards users who tip generously with faster inclusion.
        const hasPriority = entries.some(e => {
          const action = (e.payload as any)?.data
          return action && isPriorityAction(action)
        })

        // Admin-forced run: the "Execute batch now" admin button sets
        // forceImmediatePoll so this tick bypasses the batch wait. Consume
        // the flag exactly once so subsequent ticks resume normal gating.
        const forced = forceImmediatePoll
        if (forced) forceImmediatePoll = false

        // Batch accumulation: wait for more actions unless the oldest has been waiting too long
        // OR a priority action is in the queue OR an admin forced the run.
        const { minActionsPerBatch, maxWaitTime } = liveSettings
        if (!hasPriority && !forced && entries.length < minActionsPerBatch) {
          const oldestAge = Date.now() - new Date(entries[0].createdAt).getTime()
          if (oldestAge < maxWaitTime) {
            console.log(`[Validator] Waiting for more actions: ${entries.length}/${minActionsPerBatch} (oldest: ${Math.round(oldestAge / 1000)}s / ${Math.round(maxWaitTime / 1000)}s max)`)
            return
          }
          console.log(`[Validator] Max wait time reached (${Math.round(oldestAge / 1000)}s), submitting ${entries.length} action(s)`)
        }

        if (forced) {
          console.log(`[Validator] Admin-forced batch — skipping wait, processing ${entries.length} action(s)`)
        } else if (hasPriority) {
          console.log(`[Validator] Priority action detected — skipping batch wait, processing immediately`)
        }

        console.log(`\n========== [Validator] NEW POLL CYCLE ==========`)
        console.log(`[Validator] Processing ${entries.length} pending transactions`)
        console.log(`[Validator] Queue IDs: ${entries.map(e => e.id).join(', ')}`)

        // Immediately mark entries as 'processing' to prevent duplicate pickup by next poll
        const idsToMark = entries.map(e => e.id)
        await prisma.txQueue.updateMany({
          where: { id: { in: idsToMark } },
          data: { status: 'processing' }
        })
        markedAsProcessing.push(...idsToMark)
        console.log(`[Validator] Marked ${entries.length} entries as 'processing'`)

        // Log transaction details for debugging
        entries.forEach(entry => {
          const action = (entry.payload as any).data
          console.log(`[Validator] TxQueue #${entry.id}:`)
          console.log(`  - Type: ${getActionType(action.actionType)}`)
          console.log(`  - Sender ID: ${action.senderId}`)
          console.log(`  - Receiver ID: ${action.receiverId}`)
          console.log(`  - Cawonce: ${action.cawonce}`)
          console.log(`  - Status: ${entry.status}`)
          console.log(`  - Created: ${entry.createdAt}`)
        })

        // Pre-filter entries that don't have sufficient CAW for OTHER actions or insufficient tip
        const validatedEntries: typeof entries = []
        const underpricedEntries: Array<{ entry: typeof entries[0]; reason: string }> = []

        for (const entry of entries) {
          const action = (entry.payload as any).data

          // First, check if this is an OTHER action with insufficient CAW for content
          const otherValidation = await validateOtherActionCost(action)
          if (!otherValidation.valid && otherValidation.underpriced) {
            underpricedEntries.push({
              entry,
              reason: `Insufficient CAW for content: required ${otherValidation.requiredCaw} CAW`
            })
            console.log(`[Validator] Marking txQueue entry ${entry.id} as underpriced (content): required ${otherValidation.requiredCaw} CAW`)
            continue
          }

          // Then, validate the tip is sufficient for replication costs.
          // Session-signed entries carry the implicit tip pre-resolved by
          // /api/actions; owner-signed entries don't have one and rely on
          // the explicit tip in amounts[].
          const stampedImplicit = (entry as any).implicitTip
          const implicitTip = stampedImplicit != null ? BigInt(stampedImplicit) : null
          const tipValidation = await validateActionTip(action, implicitTip)
          if (!tipValidation.valid) {
            underpricedEntries.push({
              entry,
              reason: tipValidation.reason || 'Insufficient tip'
            })
            console.log(`[Validator] Marking txQueue entry ${entry.id} as underpriced (tip): ${tipValidation.reason}`)
            continue
          }

          validatedEntries.push(entry)
        }

        // Mark underpriced entries with 'underpriced' status for potential relay to other validators
        if (underpricedEntries.length > 0) {
          await Promise.all(underpricedEntries.map(({ entry, reason }) => {
            return prisma.txQueue.update({
              where: { id: entry.id },
              data: {
                status: 'underpriced',
                reason
              }
            })
          }))
        }

        // If no valid entries remain, return
        if (!validatedEntries.length) {
          console.log("[Validator] No valid entries to process after filtering")
          return
        }

        // All actions in a batch must belong to the same client (enforced by CawActions.sol).
        // If we have multiple networks, split into per-network batches and process each separately.
        const allActions = validatedEntries.map(e => (e.payload as any).data)
        const uniqueClientIds = getUniqueClientIds(allActions)
        if (uniqueClientIds.length > 1) {
          console.log(`[Validator] Batch has ${uniqueClientIds.length} unique networks, splitting into per-network batches`)

          const clientGroups = groupActionsByClient(allActions)

          for (const [clientId, indices] of clientGroups.entries()) {
            const subBatchEntries = indices.map(idx => validatedEntries[idx])
            console.log(`[Validator] Processing network ${clientId}: ${subBatchEntries.length} entries`)

            const subBatch = buildMultiActionData(subBatchEntries)

            try {
              const simResult = await span('validator.simulate', {
                'batch.size': subBatch.actions.length,
                'batch.kind': 'sub',
                'client.id': clientId,
              }, () => simulateActions(validatorId, subBatch))
              if (!simResult || !simResult.successfulActions?.length) {
                console.log(`[Validator] Network ${clientId} simulation failed or no successful actions`)
                await Promise.all(subBatchEntries.map(async (entry: any, idx) => {
                  const data = (entry.payload as any).data
                  const rejection = simResult?.rejectionMessages?.[idx] || ''
                  const cawonceUsed = rejection.includes('Cawonce already used')
                  let cawonceResolution: 'done' | 'failed' | 'awaiting_indexer' | null = null
                  if (cawonceUsed) {
                    cawonceResolution = await resolveCawonceUsed(data, entry.updatedAt, httpProvider)
                  }
                  const processedByOther = cawonceResolution === 'done'

                  let failStatus: string = processedByOther
                    ? 'done'
                    : cawonceResolution === 'awaiting_indexer'
                      ? 'awaiting_indexer'
                      : 'failed'
                  let failReason: string | null = processedByOther
                    ? null
                    : cawonceResolution === 'awaiting_indexer'
                      ? 'awaiting Action indexer'
                      : (cawonceUsed ? 'Cawonce already used' : (rejection || 'Simulation failed'))
                  if (failStatus === 'failed' && failReason) {
                    const depositCheck = await checkDepositWaiting(data.senderId, failReason)
                    failStatus = depositCheck.status
                    failReason = depositCheck.reason
                  }
                  if (processedByOther) {
                    await markTxQueueValidatedByPeer(entry.id, (entry as any).payload, (entry as any).signedTx)
                  } else if (failStatus === 'failed' && failReason) {
                    await markTxQueueFailed(entry.id, failReason, data.senderId, data)
                  } else {
                    // awaiting_indexer or waiting_for_deposit
                    await prisma.txQueue.update({
                      where: { id: entry.id },
                      data: { status: failStatus, reason: failReason }
                    })
                  }
                }))
                continue
              }

              const succeededKeys = new Set(
                simResult.successfulActions.map((a: any) => `${a.senderId}-${a.cawonce}`)
              )
              const succeededSubEntries = subBatchEntries.filter(e => {
                const data = (e.payload as any).data
                return succeededKeys.has(`${data.senderId}-${data.cawonce}`)
              })

              if (succeededSubEntries.length === 0) continue

              const succeededData = buildMultiActionData(succeededSubEntries)
              const subQuote = await recalculateQuoteForActions(succeededData)
              const gasLimit = await estimateGasLimit(validatorId, succeededData, subQuote)

              // Capture wait time before submission (not after confirmation)
              const subPreSubmitTime = Date.now()
              const subAvgWait = succeededSubEntries.reduce((s, e) => s + (subPreSubmitTime - new Date(e.createdAt).getTime()), 0) / succeededSubEntries.length

              const { processed: finalized, receipt: subReceipt } = await span('validator.submit', {
                'batch.size': succeededData.actions.length,
                'batch.kind': 'sub',
                'client.id': clientId,
              }, () => submitProcessActions(validatorId, succeededData, subQuote, gasLimit))
              console.log(`[Validator] Network ${clientId}: ${finalized.length} actions finalized`)

              // Record analytics
              if (subReceipt) {
                const subTipCaw = computeTotalTip(succeededSubEntries)
                try {
                  const subFee = subReceipt.fee ?? (subReceipt.gasUsed * (subReceipt.gasPrice ?? 0n))
                  await prisma.validatorTx.create({ data: {
                    txHash: subReceipt.hash,
                    blockNumber: BigInt(subReceipt.blockNumber),
                    actionCount: finalized.length,
                    actionBreakdown: buildActionBreakdown(succeededData.actions),
                    gasUsed: subReceipt.gasUsed.toString(),
                    gasPrice: subFee > 0n ? (subFee / subReceipt.gasUsed).toString() : '0',
                    ethCost: subFee.toString(),
                    tipCaw: subTipCaw.toString(),
                    tipEthValue: '0', // Not calculated in sub-batch path
                    profit: (0n - subFee).toString(),
                    validatorId,
                    avgWaitMs: Math.round(subAvgWait),
                  }})
                } catch (e: any) { console.error('[Analytics] ❌ Failed to record ValidatorTx:', e.message, e.stack) }
              }

              const finalizedKeys = new Set(finalized.map((f: any) => `${f.senderId}-${f.cawonce}`))
              await Promise.all(subBatchEntries.map(async (entry, idx) => {
                const data = (entry.payload as any).data
                const key = `${data.senderId}-${data.cawonce}`
                const succeeded = finalizedKeys.has(key)
                if (succeeded) {
                  // Use markTxQueueDone (not a plain update) so that
                  // incrementSessionSpent fires atomically with the status
                  // flip. A plain update here was the sub-batch session-spend
                  // drift bug (project_session_spend_drift_sub_batch_finalize.md).
                  await markTxQueueDone(entry.id, entry.payload, (entry as any).signedTx)
                } else {
                  const failReason = simResult.rejectionMessages?.[idx] || 'Transaction failed'
                  await markTxQueueFailed(entry.id, failReason, data.senderId, data)
                }
              }))
            } catch (err: any) {
              console.error(`[Validator] Network ${clientId} batch failed:`, err.message)
              await Promise.all(subBatchEntries.map(async (entry) => {
                const data = (entry.payload as any).data
                await markTxQueueFailed(entry.id, err.message, data.senderId, data)
              }))
            }
          }

          return
        }

        console.log(`[Validator] ${validatedEntries.length} valid entries to simulate`)
        const fullBatch = buildMultiActionData(validatedEntries)
        const totalTipBefore = computeTotalTip(validatedEntries)

        console.log(`[Validator] Starting simulation for validator ${validatorId} with RPC: ${l2RpcUrl}`);
        console.log(`[Validator] Simulating ${fullBatch.actions.length} actions:`, fullBatch.actions.map((a: any) => ({
          type: getActionType(a.actionType).toString(),
          sender: a.senderId,
          receiver: a.receiverId,
          cawonce: a.cawonce,
          amounts: a.amounts?.map((amt: any) => amt.toString())
        })))

        // 1) simulate
        const simulationResult = await span('validator.simulate', {
          'batch.size': fullBatch.actions.length,
          'batch.kind': 'full',
        }, () => simulateActions(validatorId, fullBatch))
        console.log(`[Validator] Simulation completed. Result:`, simulationResult ? 'RECEIVED' : 'NULL/UNDEFINED')

      // Check if simulateActions returned undefined (error case)
      if (!simulationResult) {
        console.error("[Validator] Simulation returned undefined, marking all as failed")
        const reason = 'Simulation failed - internal error'
        await Promise.all(validatedEntries.map(async (entry) => {
          const data = (entry.payload as any).data
          await markTxQueueFailed(entry.id, reason, data.senderId, data)
        }))
        return
      }

      const { successfulActions, rejectionMessages, quote } = simulationResult as any
      console.log("[Validator] Extracted simulation results:")
      console.log("  - successfulActions:", successfulActions)
      console.log("  - successfulActions.length:", successfulActions?.length)
      console.log("  - rejectionMessages:", rejectionMessages)
      console.log("  - rejectionMessages.length:", rejectionMessages?.length)
      console.log("  - quote.nativeFee:", quote?.nativeFee?.toString())
      console.log(successfulActions, '////////////////', validatedEntries);

      console.log("Simulation complete:", successfulActions.length, rejectionMessages)

      if (!successfulActions || !successfulActions.length) {
        console.log("No successful actions from simulation")

        // Check if any rejection is due to RPC/network issues (temporary) vs actual failures (permanent)
        // Check if all rejections are "Cawonce already used"
        // This could mean: (a) another validator processed THIS action, or
        // (b) a DIFFERENT action used this cawonce and the local counter is stale.
        // We check the Action table to distinguish the two cases.
        const allCawonceUsed = rejectionMessages.every((msg: string) =>
          msg?.includes('Cawonce already used')
        )
        if (allCawonceUsed) {
          console.log("[Validator] All actions rejected with 'Cawonce already used' — checking Action table...")
          await Promise.all(validatedEntries.map(async (entry: any) => {
            const data = (entry.payload as any).data
            const resolution = await resolveCawonceUsed(data, entry.updatedAt, httpProvider)
            if (resolution === 'done') {
              console.log(`[Validator] TxQueue ${entry.id}: Same action exists for senderId=${data.senderId} cawonce=${data.cawonce} — marking done`)
              await markTxQueueValidatedByPeer(entry.id, entry.payload, entry.signedTx)
            } else if (resolution === 'failed') {
              console.log(`[Validator] TxQueue ${entry.id}: Cawonce ${data.cawonce} used by DIFFERENT action (or indexer timeout) — marking failed`)
              await markTxQueueFailed(entry.id, 'Cawonce already used', data.senderId, data)
            } else {
              // awaiting_indexer — Action row not yet present. Defer to next tick.
              console.log(`[Validator] TxQueue ${entry.id}: Cawonce ${data.cawonce} reported used but Action row not yet indexed — deferring`)
              await prisma.txQueue.update({
                where: { id: entry.id },
                data: { status: 'awaiting_indexer', reason: 'awaiting Action indexer' },
              })
            }
          }))
          return
        }

        const hasTemporaryError = rejectionMessages.some((msg: string) => {
          const lowerMsg = msg?.toLowerCase() || ''
          return lowerMsg.includes('timeout') ||
                 lowerMsg.includes('network') ||
                 lowerMsg.includes('connection') ||
                 lowerMsg.includes('rpc') ||
                 lowerMsg.includes('will retry') ||
                 lowerMsg.includes('too many requests') ||
                 lowerMsg.includes('429') ||
                 lowerMsg.includes('rate limit') ||
                 lowerMsg.includes('missing response') ||
                 // Auth state hasn't been relayed from L1 to L2 yet — the
                 // user just submitted the authenticate tx and we're waiting
                 // on LayerZero (typically 1-5 min). Same race the pre-sim
                 // pendingDepositTxHash hold handles for deposits, but that
                 // gate doesn't fire here because there's no tx hash on the
                 // queued action. Retry on next poll until L2 catches up.
                 lowerMsg.includes('not authenticated with this client') ||
                 // Quick Sign session may not have landed on L2 yet — same
                 // L1→L2 race as deposit/auth. The pre-sim hold for
                 // pendingQuickSignTxHash handles the common case; this is
                 // a fallback for actions whose row didn't carry the hash
                 // (e.g. submitted shortly after, or after we cleared it on
                 // a transient watcher gap). Retry on next poll.
                 lowerMsg.includes('session expired or not found')
        })

        if (hasTemporaryError) {
          console.log("========== [Validator] TEMPORARY ERROR DETECTED ==========")
          console.log("  Resetting transactions to PENDING for automatic retry")
          console.log("  Affected TxQueue IDs:", validatedEntries.map(e => e.id).join(', '))
          console.log("  Rejection messages:", rejectionMessages)
          console.log("  These will be retried on next poll cycle")
          console.log("==========================================================")
          // EXPLICITLY reset rows to pending. The sweep at the top of
          // fetchPendingQueue (30s threshold) is the fallback safety net,
          // but it's timing-fragile when the poll interval ≈ the sweep
          // threshold: rows can cycle pending↔processing forever as each
          // poll re-bumps their updatedAt to be exactly at the cutoff
          // boundary. Observed in production on 2026-05-02 with 7 rows
          // stuck in lockstep due to a flaky WSS RPC. Direct reset is
          // race-free.
          await prisma.txQueue.updateMany({
            where: { id: { in: validatedEntries.map(e => e.id) }, status: 'processing' },
            data: { status: 'pending' },
          })
          return
        } else {
          console.log("========== [Validator] PERMANENT FAILURE DETECTED ==========")
          console.log("  Marking transactions as FAILED")
          console.log("  Affected TxQueue IDs:", validatedEntries.map(e => e.id).join(', '))
          // Per-entry routing.
          //
          // We arrived here because the "all rejections are cawonce-used"
          // guard at line 2172 didn't fire — but that guard uses .every(),
          // so a SINGLE non-cawonce-used rejection (including an empty /
          // undefined entry in rejectionMessages, which can happen when
          // simulation returns fewer messages than entries) flips the
          // whole batch into permanent-failure mode. That used to mass-
          // mark legitimate cawonce-used rows as failed without ever
          // consulting the Action table.
          //
          // Route each entry individually: cawonce-used rejections still
          // go through resolveCawonceUsed (so legit ones land as done /
          // awaiting_indexer); other rejections get the original
          // permanent-failure treatment.
          await Promise.all(validatedEntries.map(async (entry, index) => {
            const data = (entry.payload as any).data
            const rejection = rejectionMessages[index] || ''
            const isCawonceUsed = rejection.includes('Cawonce already used')

            if (isCawonceUsed) {
              const resolution = await resolveCawonceUsed(data, entry.updatedAt, httpProvider)
              if (resolution === 'done') {
                console.log(`[Validator] TxQueue ${entry.id}: Same action exists for senderId=${data.senderId} cawonce=${data.cawonce} — marking done`)
                await markTxQueueValidatedByPeer(entry.id, entry.payload, (entry as any).signedTx)
                return
              }
              if (resolution === 'awaiting_indexer') {
                console.log(`[Validator] TxQueue ${entry.id}: Cawonce ${data.cawonce} reported used but Action row not yet indexed — deferring`)
                await prisma.txQueue.update({
                  where: { id: entry.id },
                  data: { status: 'awaiting_indexer', reason: 'awaiting Action indexer' },
                })
                return
              }
              // resolution === 'failed' — different action at this cawonce
              // or the indexer-aware budget elapsed. Fall through to
              // markTxQueueFailed with the canonical reason.
              await markTxQueueFailed(entry.id, 'Cawonce already used', data.senderId, data)
              return
            }

            // Mark Caw as FAILED if this is a caw or recaw action
            // Caw / Follow / Like / Tip row cleanup is now handled inside
            // markTxQueueFailed -> cleanupOptimisticRows. No per-site cleanup
            // needed here.

            const reason = rejection || 'Simulation rejected - unknown reason'
            await markTxQueueFailed(entry.id, reason, data.senderId, data)
          }))
        }
        return
      }




      // build a Set of senderId-cawonce keys for those that passed sim:
      const succeededKeys = new Set(
        successfulActions.map((a: any) => `${a.senderId}-${a.cawonce}`)
      )

      // Check if we're on testnet
      const network = await provider.getNetwork()
      const isTestnet = Number(network.chainId) === BASE_SEPOLIA_CHAIN_ID

      if (isTestnet) {
        console.log('[Validator] Running on testnet (Base Sepolia) - gas cost will be scaled down')
      }

      // filter down to only those queue-rows that actually succeeded
      console.log("[Validator] Filtering succeeded entries from", validatedEntries.length, "total entries")
      console.log("[Validator] Rejection messages:", rejectionMessages.map((msg: string, i: number) => `[${i}]: ${msg || '(empty - success)'}`))

      const succeededEntries = validatedEntries.filter((e, index) => {
        const success = rejectionMessages[index] == '';
        const action = (e.payload as any).data
        console.log(`[Validator] Entry ${e.id} (${getActionType(action.actionType)}): ${success ? 'PASSED' : 'REJECTED: ' + rejectionMessages[index]}`)
        return success
      })

      console.log(`[Validator] ${succeededEntries.length} entries passed simulation (out of ${validatedEntries.length})`)

      if (succeededEntries.length === 0) {
        console.log("[Validator] No entries passed simulation - all rejected. Not submitting transaction.")
        // The rejections will be handled in the next section
      }

      // rebuild your call data only with the succeeded entries
      const multiSucceeded = buildMultiActionData(succeededEntries)
      console.log("LENGH", multiSucceeded.actions.length)
      console.log("ready to roll:", multiSucceeded.actions.length)



      // Recalculate quote for the succeeded actions only (may have different clients)
      // This ensures we only pay for replication of successful actions
      const succeededQuote = await recalculateQuoteForActions(multiSucceeded)

      // 2) estimate gas cost
      console.log("[Validator] Estimating gas cost...")
      const gasCost = await estimateProcessGasCost(
        validatorId, multiSucceeded, succeededQuote
      )
      console.log("[Validator] Estimated gas cost:", gasCost.toString(), "wei")

      console.log("[Validator] Estimating gas limit...")
      const rawGasLimit = await estimateGasLimit(
        validatorId, multiSucceeded, succeededQuote
      );
      console.log("[Validator] Estimated gas limit:", rawGasLimit.toString())

      // recompute tip from only the successful ones
      const totalTipCaw = computeTotalTip(succeededEntries)

      // Convert CAW tip to ETH using Uniswap getAmountsOut
      console.log(`[Validator] Converting ${totalTipCaw} CAW to ETH via Uniswap...`)
      const tipInWei = await cawToEth(totalTipCaw, ethMainnetRpcUrl)

      // On testnet, scale down gas cost to simulate mainnet economics
      // (testnet gas is essentially free, but we want the check to still work)
      const effectiveGasCost = isTestnet ? gasCost / TESTNET_GAS_SCALE_FACTOR : gasCost

      console.log(`[Validator] Tip calculation:`)
      console.log(`  - Total tip: ${totalTipCaw} CAW`)
      console.log(`  - Tip value: ${tipInWei.toString()} wei (${Number(tipInWei) / 1e18} ETH)`)
      console.log(`  - Raw gas cost: ${gasCost.toString()} wei`)
      if (isTestnet) {
        console.log(`  - Scaled gas cost (testnet): ${effectiveGasCost.toString()} wei (÷${TESTNET_GAS_SCALE_FACTOR})`)
      }
      console.log(`  - Tip >= Gas cost? ${tipInWei >= effectiveGasCost}`)

      // Check if tip covers gas cost
      if (tipInWei < effectiveGasCost) {
        console.log("[Validator] ❌ SKIPPING - Tip is less than gas cost!")
        console.log(`[Validator] ========== GAS COST FAILURE DETAILS ==========`)
        console.log(`[Validator]   Network:            ${isTestnet ? 'Base Sepolia (testnet)' : 'Base Mainnet'}`)
        console.log(`[Validator]   Raw gas cost (wei): ${gasCost.toString()}`)
        if (isTestnet) {
          console.log(`[Validator]   Scale factor:       ÷${TESTNET_GAS_SCALE_FACTOR}`)
        }
        console.log(`[Validator]   Effective gas cost: ${effectiveGasCost.toString()} wei`)
        console.log(`[Validator]   Tip provided (CAW): ${totalTipCaw.toString()}`)
        console.log(`[Validator]   Tip value (wei):    ${tipInWei.toString()}`)
        console.log(`[Validator]   Tip value (ETH):    ${Number(tipInWei) / 1e18}`)
        console.log(`[Validator]   Shortfall (wei):    ${(effectiveGasCost - tipInWei).toString()}`)
        // Log each action's amounts
        succeededEntries.forEach((entry, i) => {
          const action = (entry.payload as any).data
          console.log(`[Validator]   Action ${i} (${getActionType(action.actionType)}): amounts = [${action.amounts?.join(', ') || 'none'}]`)
        })
        console.log(`[Validator] ==============================================`)
        // Mark all entries as failed due to insufficient tip
        const failReason = `Insufficient tip: ${totalTipCaw} CAW (${Number(tipInWei) / 1e18} ETH) < gas cost ${Number(effectiveGasCost) / 1e18} ETH`
        await updateQueueStatuses(entries, [],
          entries.map(() => failReason))
        return
      }

      console.log(`[Validator] ✅ Tip check passed${isTestnet ? ' (testnet scaled)' : ''} - proceeding with submission`)

      console.log("[Validator] Submitting transaction with", multiSucceeded.actions.length, "actions")
      console.log("[Validator] Actions to submit:", multiSucceeded.actions.map((a: any) => ({
        type: getActionType(a.actionType).toString(),
        sender: a.senderId,
        receiver: a.receiverId,
        cawonce: a.cawonce
      })))

      let finalized: any[] = [];
      let submissionError: string | null = null;
      // Per-entry overrides from the bisect / re-sim recovery path. When a
      // batch tx reverts, we re-simulate to catch mirror races and bisect to
      // isolate sim-passes-but-tx-reverts actions (e.g. the underestimated
      // LayerZero withdraw fee). The recovery path resolves entries directly
      // here so the reconciliation block below can defer to its verdict.
      //   succeeded:true               -> mark done
      //   succeeded:false, reason      -> markTxQueueFailed with that reason
      //   pending:true                 -> reset to pending for next-poll retry
      type RecoveryVerdict =
        | { succeeded: true }
        | { succeeded: false; reason: string }
        | { pending: true }
      const recoveryByEntryId = new Map<number, RecoveryVerdict>()

      try {
        console.log("[Validator] ========== SUBMITTING TRANSACTION TO BLOCKCHAIN ==========")
        // Capture wait time before submission (not after confirmation, which adds block time)
        const preSubmitTime = Date.now()
        const avgWait = succeededEntries.reduce((s: number, e: any) => s + (preSubmitTime - new Date(e.createdAt).getTime()), 0) / succeededEntries.length
        const submitResult = await span('validator.submit', {
          'batch.size': multiSucceeded.actions.length,
          'batch.kind': 'full',
        }, () => submitProcessActions(
           validatorId, multiSucceeded, succeededQuote, rawGasLimit
         ))
        finalized = submitResult.processed
        const txReceipt = submitResult.receipt
        console.log(`[Validator] ✓ ${finalized.length} action(s) finalized on chain`)

        // Record analytics
        if (txReceipt) {
          try {
            const txFee = txReceipt.fee ?? (txReceipt.gasUsed * (txReceipt.gasPrice ?? 0n))
            await prisma.validatorTx.create({ data: {
              txHash: txReceipt.hash,
              blockNumber: BigInt(txReceipt.blockNumber),
              actionCount: finalized.length,
              actionBreakdown: buildActionBreakdown(multiSucceeded.actions),
              gasUsed: txReceipt.gasUsed.toString(),
              gasPrice: txFee > 0n ? (txFee / txReceipt.gasUsed).toString() : '0',
              ethCost: txFee.toString(),
              tipCaw: totalTipCaw.toString(),
              tipEthValue: tipInWei.toString(),
              profit: (tipInWei - txFee).toString(),
              validatorId,
              avgWaitMs: Math.round(avgWait),
            }})
          } catch (e: any) { console.error('[Analytics] ❌ Failed to record ValidatorTx:', e.message, e.stack) }
        }

      } catch (submitErr: any) {
        console.error("[Validator] ========== TRANSACTION SUBMISSION FAILED ==========")
        console.error("[Validator] Full error object:", submitErr)
        console.error("[Validator] Error message:", submitErr.message)
        console.error("[Validator] Error code:", submitErr.code)
        console.error("[Validator] Error stack:", submitErr.stack)

        // Check if this is a provider/network/rate-limit error that should be retried
        const errMsg = (submitErr.message || '').toLowerCase()
        const isTransient =
          submitErr.code === 'UNSUPPORTED_OPERATION' ||
          submitErr.code === 'BAD_DATA' ||
          submitErr.code === 'UNKNOWN_ERROR' ||
          errMsg.includes('provider destroyed') ||
          errMsg.includes('cancelled request') ||
          errMsg.includes('too many requests') ||
          errMsg.includes('429') ||
          errMsg.includes('rate limit') ||
          errMsg.includes('missing response') ||
          errMsg.includes('internal error') ||
          errMsg.includes('could not coalesce') ||
          errMsg.includes('timeout') ||
          errMsg.includes('enotfound') ||
          errMsg.includes('econnrefused') ||
          errMsg.includes('econnreset')
        if (isTransient) {
          console.log('[Validator] Transient error during submission — keeping entries pending for retry:', errMsg.slice(0, 150))
          if (USE_WS) {
            await initializeConnection()
          } else if (errMsg.includes('provider destroyed') || errMsg.includes('cancelled request') || submitErr.code === 'UNSUPPORTED_OPERATION') {
            // Same reasoning as the simulation-error path above:
            // initializeConnection's WS-cleanup branch destroys the
            // shared httpProvider in no-WS mode. Use the targeted
            // rebuilder instead. Other transient errors (429, network
            // hiccups) just need a retry — no rebuild necessary.
            rebuildHttpProvider(`error in submission: ${errMsg.slice(0, 80)}`)
          }
          return
        }

        // Non-transient revert. Two cases we can recover from:
        //   (a) Mirror race — sim was right at the time but another mirror
        //       landed one of our cawonces between sim and submit. A fresh
        //       sim now flags the bad action(s); the rest can retry.
        //   (b) Sim-passes-but-tx-reverts (e.g. underestimated LayerZero
        //       withdraw fee). Re-sim still says all-good. Bisect to isolate
        //       the bad action(s) so they only fail themselves.
        const revertReason = submitErr.message || 'Failed to submit transaction'
        try {
          const recoveryHandled = await recoverBatchFailure(
            validatorId, succeededEntries, revertReason, recoveryByEntryId, finalized
          )
          if (recoveryHandled) {
            // recoverBatchFailure populated recoveryByEntryId for every
            // submitted entry; reconciliation below honors those verdicts.
            submissionError = null
          } else {
            submissionError = revertReason
          }
        } catch (recoveryErr: any) {
          console.error('[Validator] Batch failure recovery threw — falling back to mark-all-failed:', recoveryErr.message)
          submissionError = revertReason
        }
        // For entries we did NOT resolve in recovery, finalized + submissionError
        // drive the existing reconciliation: any submitted entry without a
        // recovery verdict and not in finalized gets marked failed.
      }

      // 4) update database - properly track which entries succeeded vs failed
      // Build array to track success/failure for each original entry. The
      // recovery path (re-sim + bisect) may have already resolved some
      // entries directly — those verdicts win over the default reconciliation.
      type Verdict = { succeeded: boolean; reason: string | null; pending?: true }
      const finalStatuses: Verdict[] = validatedEntries.map((entry, index) => {
        // Recovery override (only set for entries that went through the
        // re-sim / bisect path).
        const override = recoveryByEntryId.get(entry.id)
        if (override) {
          if ('pending' in override) {
            return { succeeded: false, reason: null, pending: true }
          }
          if (override.succeeded) {
            return { succeeded: true, reason: null }
          }
          return { succeeded: false, reason: override.reason }
        }
        // Check if this entry was in the succeeded set that got submitted
        const wasSubmitted = succeededEntries.includes(entry)
        if (!wasSubmitted) {
          // This entry failed simulation
          // The rejection message for this specific entry is at rejectionMessages[index]
          return { succeeded: false, reason: rejectionMessages[index] || 'Simulation failed' }
        }
        // This entry was submitted
        if (submissionError) {
          // Transaction submission threw an error (e.g., reverted)
          return { succeeded: false, reason: submissionError }
        }
        // Check if it finalized successfully
        const data = (entry.payload as any).data
        const isFinalized = finalized.some(
          f => f.senderId === data.senderId && f.cawonce === data.cawonce
        )
        return {
          succeeded: isFinalized,
          reason: isFinalized ? null : 'Transaction failed on chain'
        }
      })

      // Update each entry with its actual status. Logs only anomalies
      // (failures, already-done skips) per-row; the summary at the end
      // reports the success count.
      let txSuccess = 0
      let txFailed = 0
      let txPending = 0
      await Promise.all(validatedEntries.map(async (entry, index) => {
        const status = finalStatuses[index]
        const { succeeded, reason } = status
        const data = (entry.payload as any).data

        // Recovery requeue: re-sim flagged a different entry, this one is
        // innocent — reset to pending so the next poll batches it again.
        if (status.pending) {
          await prisma.txQueue.updateMany({
            where: { id: entry.id, status: 'processing' },
            data: { status: 'pending', reason: null },
          })
          txPending++
          return
        }

        if (!succeeded) {
          const currentEntry = await prisma.txQueue.findUnique({
            where: { id: entry.id },
            select: { status: true }
          })
          if (currentEntry?.status === 'done' || currentEntry?.status === 'validated_by_peer') {
            // Another path already marked this done — nothing to do, quiet skip.
            return
          }
        }

        if (succeeded) {
          await prisma.txQueue.update({
            where: { id: entry.id },
            data: { status: 'done', reason: null }
          })
          // Increment the session key's locally-tracked spent counter so the
          // /api/actions fast-path spend-limit check stays accurate without
          // a live sessionSpent() RPC call per submission.
          await incrementSessionSpent(prisma as any, entry.payload as any, entry.signedTx)
          txSuccess++
        } else {
          await markTxQueueFailed(entry.id, reason || 'Transaction failed', data.senderId, data)
          txFailed++
          console.warn(`[Validator] TxQueue #${entry.id} (${getActionType(data.actionType)} from ${data.senderId}) FAILED: ${reason || 'unknown'}`)
        }
      }))
      if (txFailed > 0 || txPending > 0) {
        console.log(`[Validator] TxQueue updated: ${txSuccess} success, ${txFailed} failed, ${txPending} reset to pending`)
      }

      // Update caw status for CAW actions that were processed. Like the
      // TxQueue loop above: log only anomalies (failures), not successes.
      await Promise.all(validatedEntries.map(async (entry, index) => {
        const status = finalStatuses[index]
        const { succeeded, reason } = status
        const data = (entry.payload as any).data

        // Pending requeues (recovery path): leave Caw row alone — it's still
        // in flight, will resolve next poll.
        if (status.pending) return

        // Check if this is a CAW action
        if (data.actionType === 0 || data.actionType === 'caw') {
          if (succeeded) {
            try {
              await prisma.caw.update({
                where: {
                  userId_cawonce: {
                    userId: data.senderId,
                    cawonce: data.cawonce
                  }
                },
                data: { status: 'SUCCESS' }
              })
            } catch (cawUpdateErr) {
              console.error(`Failed to mark caw SUCCESS (user ${data.senderId} cawonce ${data.cawonce}):`, cawUpdateErr)
            }
          } else {
            // Before marking as FAILED, check if it's already SUCCESS
            try {
              const existingCaw = await prisma.caw.findUnique({
                where: {
                  userId_cawonce: {
                    userId: data.senderId,
                    cawonce: data.cawonce
                  }
                },
                select: { status: true }
              })

              if (existingCaw && existingCaw.status !== 'SUCCESS') {
                await prisma.caw.update({
                  where: {
                    userId_cawonce: {
                      userId: data.senderId,
                      cawonce: data.cawonce
                    }
                  },
                  data: {
                    status: 'FAILED',
                    reason: reason || 'Transaction failed'
                  }
                })
                console.log(`[Validator] Marked caw FAILED (user ${data.senderId} cawonce ${data.cawonce}): ${reason}`)
              }
              // If existingCaw?.status === 'SUCCESS', another path already
              // confirmed it — quiet no-op.
            } catch (cawUpdateErr) {
              console.error('Failed to mark caw FAILED:', cawUpdateErr)
            }
          }
        }

        // Check if this is a WITHDRAW action (actionType: 6)
        if (data.actionType === 6 || data.actionType === 'WITHDRAW') {
          if (succeeded) {
            // Mark withdrawal request as completed
            try {
              const withdrawalRequest = await prisma.withdrawalRequest.findFirst({
                where: {
                  userId: data.senderId,
                  cawonce: data.cawonce
                }
              })

              if (withdrawalRequest) {
                await prisma.withdrawalRequest.update({
                  where: { id: withdrawalRequest.id },
                  data: {
                    status: 'completed',
                    completedAt: new Date()
                  }
                })
                console.log(`[ValidatorService] Marked withdrawal request as completed for user ${data.senderId} cawonce ${data.cawonce}`)
              } else {
                console.warn(`[ValidatorService] No withdrawal request found for user ${data.senderId} cawonce ${data.cawonce}`)
              }
            } catch (withdrawalUpdateErr) {
              console.error('[ValidatorService] Failed to update withdrawal request status:', withdrawalUpdateErr)
              // Continue even if withdrawal update fails
            }
          } else {
            // Mark withdrawal request as failed
            try {
              const withdrawalRequest = await prisma.withdrawalRequest.findFirst({
                where: {
                  userId: data.senderId,
                  cawonce: data.cawonce
                }
              })

              if (withdrawalRequest) {
                await prisma.withdrawalRequest.update({
                  where: { id: withdrawalRequest.id },
                  data: {
                    status: 'failed'
                  }
                })
                console.log(`[ValidatorService] Marked withdrawal request as failed for user ${data.senderId} cawonce ${data.cawonce}: ${reason}`)
              }
            } catch (withdrawalUpdateErr) {
              console.error('[ValidatorService] Failed to update withdrawal request status to failed:', withdrawalUpdateErr)
              // Continue even if withdrawal update fails
            }
          }
        }

      }))
      } catch (err: any) {
        console.error("[Validator] Poll loop error:", {
          message: err.message,
          code: err.code,
          rpcUrl: redactRpcUrl(l2RpcUrl)
        })
        // Roll back any rows we marked 'processing' that the loop didn't get
        // a chance to move to a terminal state. The WHERE-clause filter on
        // status='processing' guarantees we never overwrite a row that
        // already reached done/failed/underpriced/awaiting_indexer further
        // down the loop. Without this rollback, an RPC hang strands rows
        // until the next poll's 30s stale-sweep — which under sustained
        // RPC flake means the queue grows faster than it drains.
        if (markedAsProcessing.length > 0) {
          try {
            const reset = await prisma.txQueue.updateMany({
              where: { id: { in: markedAsProcessing }, status: 'processing' },
              data: { status: 'pending' },
            })
            if (reset.count > 0) {
              console.log(`[Validator] Rolled back ${reset.count} 'processing' rows to 'pending' after poll error`)
            }
          } catch (rollbackErr: any) {
            console.error("[Validator] Failed to roll back processing rows:", rollbackErr.message)
          }
        }
        // Don't crash on errors, will retry on next interval
      }
    }

    /**
     * Decode known custom error selectors into human-readable strings.
     * Add new entries as we hit them so future failures are diagnosable
     * without grepping ABIs by hand.
     *
     * Returns null if the data isn't a recognized custom error.
     */
    function decodeCustomError(data: string | undefined | null): string | null {
      if (!data || typeof data !== 'string' || !data.startsWith('0x') || data.length < 10) return null
      const selector = data.slice(0, 10).toLowerCase()
      const body = '0x' + data.slice(10)

      const fmtEth = (wei: bigint): string => {
        const n = Number(wei) / 1e18
        if (n === 0) return '0 ETH'
        if (n >= 0.001) return `${n.toFixed(6)} ETH`
        return `${n.toExponential(3)} ETH (${wei} wei)`
      }

      try {
        const coder = new AbiCoder()

        // LZ_InsufficientFee(uint256 requiredNative, uint256 suppliedNative,
        //                    uint256 requiredLzToken, uint256 suppliedLzToken)
        if (selector === '0x4f3ec0d3') {
          const [reqN, supN, reqL, supL] = coder.decode(['uint256', 'uint256', 'uint256', 'uint256'], body)
          const reqNb = BigInt(reqN), supNb = BigInt(supN)
          const shortBy = reqNb > supNb ? reqNb - supNb : 0n
          const pct = reqNb > 0n ? Number(shortBy * 10000n / reqNb) / 100 : 0
          return `LZ_InsufficientFee — required ${fmtEth(reqNb)}, supplied ${fmtEth(supNb)}` +
                 (shortBy > 0n ? ` (short by ${fmtEth(shortBy)} ≈ ${pct}%; bump LZ fee buffer)` : ` (LZ token: req=${reqL}, sup=${supL})`)
        }

        // LZ_MessageLib_InvalidMessageSize(uint256 actual, uint256 max)
        if (selector === '0xc667af3e') {
          const [actual, max] = coder.decode(['uint256', 'uint256'], body)
          return `LZ_InvalidMessageSize — payload ${actual} bytes exceeds limit ${max} bytes (raise maxMessageSize via setConfig)`
        }

        // OnlyOwner / generic Ownable
        if (selector === '0x82b42900') return 'Unauthorized — only owner'
      } catch {
        // Decoder failed — fall through to return null
      }
      return null
    }

    function formatRpcError(err: any): string {
      // Extract the most useful info from ethers error blobs.
      // Check the most specific signals first — ethers errors can have lots of
      // fields and we want to avoid substring matches on arbitrary message text.

      // 0. Try to decode known custom errors first (LZ_InsufficientFee, etc.)
      const errData = err?.data || err?.error?.data || err?.info?.error?.data
      const decoded = decodeCustomError(errData)
      if (decoded) {
        const txHash = err?.receipt?.hash || err?.transaction?.hash
        return `${decoded}${txHash ? ` — tx: ${txHash}` : ''}`
      }

      // 1. Contract revert (the most common "error" from writes)
      if (err?.code === 'CALL_EXCEPTION') {
        const reason = err.reason || err.revert?.args?.[0]
        const status = err.receipt?.status
        const txHash = err.receipt?.hash || err.transaction?.hash
        if (status === 0 || status === '0') {
          return `Transaction reverted${reason ? `: ${reason}` : ' (no reason)'} — tx: ${txHash}`
        }
        return `Call exception${reason ? `: ${reason}` : ''}`
      }

      // 2. Insufficient funds for gas + value
      if (err?.code === 'INSUFFICIENT_FUNDS' || err?.message?.includes('insufficient funds')) {
        return `Insufficient funds for tx (gas + value)`
      }

      // 3. RPC-level errors (inspect err.info.payload to know which method).
      // ethers wraps RPC errors with error.code from the server (-32xxx).
      const rpcCode = err?.error?.code ?? err?.info?.error?.code
      const rpcMessage = err?.error?.message ?? err?.info?.error?.message
      const method = err?.info?.payload?.method

      if (rpcCode === -32005 || rpcMessage?.includes('Too Many Requests')) {
        return `RPC rate limited on ${method || 'unknown'}`
      }
      if (rpcCode === -32000 && rpcMessage?.includes('oversized data')) {
        return `Oversized transaction data: ${rpcMessage}`
      }
      if (rpcCode === -32000 && rpcMessage?.includes('internal error')) {
        return `RPC internal error on ${method || 'unknown'}: ${rpcMessage}`
      }
      if (rpcCode === -32600 || rpcMessage?.includes('Unauthorized')) {
        return `RPC auth failed — check API key`
      }

      // 4. HTTP-level auth errors (before ethers wraps them)
      if (err?.code === 'SERVER_ERROR' && err?.info?.responseStatus === '401 Unauthorized') {
        return `RPC auth failed (HTTP 401) — check API key`
      }

      // 5. Anything else: full message (truncated)
      const msg = err?.shortMessage || err?.message || String(err)
      return msg.length > 300 ? msg.slice(0, 300) + '...' : msg
    }

    // HTTP provider for replication — created once, reused across cycles.
    // WebSocket can fail on historical tx lookups; HTTP is more reliable
    // for the bulk data fetching the reconstruction needs.
    const replicationHttpRpcUrl = getL2HttpRpcUrl(l2RpcUrl)
    const replicationHttpProvider = makeJsonRpcProvider(replicationHttpRpcUrl, 84532)
    console.log(`[Replication] HTTP RPC: ${redactRpcUrl(replicationHttpRpcUrl)}`)


    // ================================================================
    // Optimistic replication: direct L2b submission with stake + fraud proofs
    // ================================================================

    // Map REPLICATION_CHAIN → { chainId, env, chainKey } so we can resolve the
    // archive address from deployments.ts at runtime. The per-install
    // CAW_ACTIONS_ARCHIVE_ADDRESS in addresses.ts is the *storage-chain*
    // archive (same chain as the client's CawActions), which is the wrong
    // contract when an operator replicates *across* chains — the most
    // common case. Reading deployments[env][chainKey].CawActionsArchive
    // gives the archive that lives on the chain we're actually submitting to.
    const REPLICATION_CHAIN_META: Record<string, { chainId: number; env: Env; chainKey: ChainKey }> = {
      'arbitrum-sepolia': { chainId: 421614, env: 'testnet', chainKey: 'L2b' },
      'arbitrum-one':     { chainId: 42161,  env: 'mainnet', chainKey: 'L2b' },
      'arbitrum':         { chainId: 42161,  env: 'mainnet', chainKey: 'L2b' },
      'base-sepolia':     { chainId: 84532,  env: 'testnet', chainKey: 'L2'  },
      'base':             { chainId: 8453,   env: 'mainnet', chainKey: 'L2'  },
    }
    function resolveReplicationArchive(replicationChain: string): { address: string; chainId: number } {
      const meta = REPLICATION_CHAIN_META[replicationChain]
      if (!meta) {
        throw new Error(
          `REPLICATION_CHAIN="${replicationChain}" — supported keys: ${Object.keys(REPLICATION_CHAIN_META).join(', ')}`
        )
      }
      const block = deployments[meta.env]?.[meta.chainKey]
      const address = block?.CawActionsArchive
      if (!address) {
        throw new Error(
          `No CawActionsArchive deployment for ${meta.env}/${meta.chainKey} ` +
          `(REPLICATION_CHAIN=${replicationChain}) in client/src/abi/deployments.ts`
        )
      }
      return { address, chainId: meta.chainId }
    }

    // Resolved once getL2bContracts() runs. The fallback to the install-time
    // constant is for CLI / debug paths that read OPTIMISTIC_ARCHIVE_ADDRESS
    // before getL2bContracts() has been called — only correct when the
    // operator's storage chain happens to equal their replication chain
    // (rare, but harmless when it's true).
    let OPTIMISTIC_ARCHIVE_ADDRESS = CAW_ACTIONS_ARCHIVE_ADDRESS
    // One-shot guard so the CLI stake-setup prompt prints once per process,
    // not every 30s when the replicator loop re-fires.
    let underStakedWarned = false
    // Same one-shot pattern for the L1-storage skip notice.
    let skippedL1ClientsWarned = false
    const ethers_formatStake = (wei: bigint) => (Number(wei) / 1e18).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
    const CHALLENGE_RELAY_ADDRESS = CAW_CHALLENGE_RELAY_ADDRESS
    // V2 CawActionsArchive.MIN_STAKE = 0.05 ETH (raised from 0.01 in V1 after the
    // Round-2 censorship-drill finding that an attacker at 0.01 stake could
    // economically sustain ~2000 slash-grief cycles). Must match the on-chain
    // constant — too low here and submitReplication() reverts with InsufficientStake.
    const OPTIMISTIC_MIN_STAKE = BigInt('50000000000000000')      // 0.05 ETH
    // Deposit 2× MIN_STAKE on first run so the validator comfortably clears the
    // floor even with minor gas-estimation drift. (V1 was 0.02 ETH = 2× 0.01.)
    const OPTIMISTIC_INITIAL_DEPOSIT = BigInt('100000000000000000') // 0.10 ETH (2× MIN_STAKE)
    const OPTIMISTIC_CHECKPOINT_INTERVAL = 32

    const archiveAbi = [
      'function stakes(address) view returns (uint256)',
      'function pendingCount(address) view returns (uint256)',
      'function deposit() payable',
      'function withdraw(uint256)',
      'function submitReplication(uint32 networkId, uint256 startCheckpointId, uint256 endCheckpointId, bytes packedActions, bytes32[] r, bytes32 merkleRoot, bytes32 entryHash)',
      'function finalizeSubmission(uint256 submissionId)',
      'function checkpointClaimed(uint32, uint256) view returns (uint256)',
      'function isRangeAvailable(uint32 networkId, uint256 start, uint256 end) view returns (bool)',
      'function getSubmission(uint256) view returns (address submitter, bytes32 merkleRoot, uint32 networkId, uint256 startCheckpointId, uint256 endCheckpointId, uint256 finalizedAt, uint8 status)',
      'function nextSubmissionId() view returns (uint256)',
      'event SubmissionCreated(uint256 indexed submissionId, address indexed submitter, uint32 indexed networkId, uint256 startCheckpointId, uint256 endCheckpointId, bytes32 merkleRoot)',
      // ActionsArchived now carries hashes only; the underlying packedActions
      // and r[] live in the originating tx's calldata. Consumers fetch them
      // via decodeArchiveSubmissionFromTx() below.
      'event ActionsArchived(uint256 indexed submissionId, uint32 indexed networkId, uint16 actionCount, bytes32 packedHash, bytes32 rHash, bytes32 entryHash)',
    ]

    /**
     * Pull packedActions + r[] + entryHash out of a CawActionsArchive tx that
     * called submitReplication. Replaces the old "read from ActionsArchived
     * event" path now that the event only carries commitments.
     */
    const archiveSubmitIface = new Interface([
      'function submitReplication(uint32 networkId, uint256 startCheckpointId, uint256 endCheckpointId, bytes packedActions, bytes32[] r, bytes32 merkleRoot, bytes32 entryHash)',
    ])
    async function decodeArchiveSubmissionFromTx(
      provider: { getTransaction: (h: string) => Promise<{ data?: string } | null> },
      txHash: string
    ): Promise<{ packedActions: string; r: string[]; entryHash: string } | null> {
      const tx = await provider.getTransaction(txHash)
      if (!tx?.data) return null
      try {
        const parsed = archiveSubmitIface.parseTransaction({ data: tx.data })
        if (!parsed || parsed.name !== 'submitReplication') return null
        return {
          packedActions: parsed.args.packedActions as string,
          r: parsed.args.r as string[],
          entryHash: parsed.args.entryHash as string,
        }
      } catch {
        return null
      }
    }

    // Lazily initialized L2b provider + contracts (only when optimistic mode is enabled)
    let l2bProvider: JsonRpcProvider | null = null
    let l2bSubmitter: ValidatorSigner | null = null   // SUBMITTER — may be REPLICATOR_PRIVATE_KEY in test mode
    let l2bMonitor: ValidatorSigner | null = null     // MONITOR/challenger — always the main validator key
    let archiveRead: Contract | null = null
    let archiveWrite: Contract | null = null          // bound to l2bSubmitter

    // Slash-test knobs. When both are set, submissions fire from a separate
    // wallet (so slashed ETH visibly moves to the main validator who challenges)
    // and deliberately commit a bad merkle root so the monitor can catch them.
    // CORRUPT_REPLICATION and CORRUPT_MODE BOTH must be set — no defaults.
    // Twin-key gate so a single fat-fingered env var can't accidentally
    // start producing fraud (and losing your stake) in production.
    //
    // CORRUPT_MODE choices:
    //   "A": keep packedActions honest but commit a bad merkleRoot.
    //        Caught by monitor's Mode-A branch → slashIncoherentRoot.
    //   "B": corrupt one byte of packedActions and build a root consistent
    //        with that corruption. Caught by monitor's Mode-B branch →
    //        resolveChallenge with submitter's claimedHash + proof.
    const _rawCorruptMode = (process.env.CORRUPT_MODE || '').toUpperCase()
    const CORRUPT_REPLICATION =
      process.env.CORRUPT_REPLICATION === 'true' &&
      (_rawCorruptMode === 'A' || _rawCorruptMode === 'B')
    const CORRUPT_MODE = CORRUPT_REPLICATION ? _rawCorruptMode : ''
    if (process.env.CORRUPT_REPLICATION === 'true' && !CORRUPT_REPLICATION) {
      console.warn(
        `[OptimisticReplication] CORRUPT_REPLICATION=true was set but ` +
        `CORRUPT_MODE is missing/invalid (got "${process.env.CORRUPT_MODE}"). ` +
        `Refusing to corrupt — set CORRUPT_MODE to A or B explicitly to enable.`
      )
    }
    const REPLICATOR_PRIVATE_KEY = process.env.REPLICATOR_PRIVATE_KEY

    async function getL2bContracts() {
      if (l2bProvider && l2bSubmitter && l2bMonitor && archiveRead && archiveWrite) {
        return { l2bProvider, l2bSubmitter, l2bMonitor, archiveRead, archiveWrite }
      }
      // REPLICATION_RPC + REPLICATION_CHAIN are the canonical names; falls
      // back to L2B_RPC_URL when an operator hasn't set the dedicated
      // replicator RPC (the two are typically the same chain anyway).
      const l2bRpcUrl = getReplicationHttpRpcUrl()
      if (!l2bRpcUrl) throw new Error('REPLICATION_RPC not set — required for optimistic replication')

      // Resolve REPLICATION_CHAIN → { chainId, archive address } via the
      // single source of truth in deployments.ts. Throws if the operator
      // chose an unsupported chain or there's no archive deployed there.
      const replicationChain = process.env.REPLICATION_CHAIN || 'arbitrum-sepolia'
      const resolved = resolveReplicationArchive(replicationChain)
      OPTIMISTIC_ARCHIVE_ADDRESS = resolved.address
      const expectedChainId = resolved.chainId

      const provider = makeJsonRpcProvider(l2bRpcUrl, expectedChainId)

      // SLASHING-ADJACENT VERIFICATION: confirm the RPC actually serves the
      // chain we think it does. ethers' staticNetwork option pins the chainId
      // for signing purposes but does NOT verify it against the RPC's
      // eth_chainId. Without this check, a hijacked DNS / BGP path could
      // route the validator to a rogue archive on a different chain where
      // our stake gets drained. Fail loud here rather than discover the
      // mismatch via a slashed submission. Audit fix 2026-05-13 (V3).
      let actualChainId: bigint
      try {
        const net = await provider.getNetwork()
        actualChainId = net.chainId
      } catch (e: any) {
        throw new Error(`[OptimisticReplication] could not read chainId from REPLICATION_RPC: ${e?.message || e}`)
      }
      if (Number(actualChainId) !== expectedChainId) {
        throw new Error(
          `[OptimisticReplication] CHAIN MISMATCH: REPLICATION_CHAIN=${replicationChain} ` +
          `expects chainId ${expectedChainId}, but the RPC reports ${actualChainId}. ` +
          `Refusing to submit — this is a slashing risk. Check REPLICATION_RPC ` +
          `points at the right chain.`
        )
      }

      l2bProvider = provider

      // Submitter uses REPLICATOR_PRIVATE_KEY if present (test mode), else main validator.
      // Both go through the signer abstraction so they can be swapped to a
      // KMS/HSM/socket backend later without touching the submission code.
      l2bSubmitter = requireValidatorSigner({
        provider: l2bProvider,
        privateKeyEnv: REPLICATOR_PRIVATE_KEY ? 'REPLICATOR_PRIVATE_KEY' : 'VALIDATOR_PRIVATE_KEY',
      })
      l2bMonitor = requireValidatorSigner({ provider: l2bProvider })

      archiveRead = new Contract(OPTIMISTIC_ARCHIVE_ADDRESS, archiveAbi, l2bProvider)
      archiveWrite = new Contract(OPTIMISTIC_ARCHIVE_ADDRESS, archiveAbi, l2bSubmitter.asEthersSigner())

      console.log(`[OptimisticReplication] L2b RPC: ${redactRpcUrl(l2bRpcUrl)} (chainId ${expectedChainId} verified)`)
      console.log(`[OptimisticReplication] Archive: ${OPTIMISTIC_ARCHIVE_ADDRESS}`)
      console.log(`[OptimisticReplication] Submitter: ${l2bSubmitter.getAddress()}${REPLICATOR_PRIVATE_KEY ? ' (REPLICATOR test key)' : ''}`)
      console.log(`[OptimisticReplication] Monitor:   ${l2bMonitor.getAddress()}`)
      if (CORRUPT_REPLICATION) {
        console.warn(`[OptimisticReplication] ⚠️  CORRUPT_REPLICATION=true CORRUPT_MODE=${CORRUPT_MODE} — next submission will be fraudulent`)
      }

      return { l2bProvider, l2bSubmitter, l2bMonitor, archiveRead, archiveWrite }
    }

    /**
     * Shared helper: reconstruct ordered actions + r values from L2 events
     * for a given network and checkpoint range. Reuses the exact same logic as
     * the existing replicationLoop.
     *
     * Returns null if reconstruction fails (caller should skip/retry).
     */
    async function reconstructCheckpointData(
      clientId: number,
      startCheckpointId: number,
      endCheckpointId: number,
    ): Promise<{
      allActions: any[]
      allR: string[]
      packedBytes: Uint8Array
      checkpointHashes: string[]
      entryHash: string
    } | null> {
      const httpProvider = replicationHttpProvider
      const numCheckpoints = endCheckpointId - startCheckpointId + 1
      const totalActionsNeeded = numCheckpoints * OPTIMISTIC_CHECKPOINT_INTERVAL

      // Read networkActionCount from CawActions to know total actions
      const cawActionsViewAbi = ['function networkActionCount(uint32) view returns (uint256)']
      const cawActionsView = new Contract(CAW_ACTIONS_ADDRESS, cawActionsViewAbi, httpProvider)
      const actionCount = Number(await cawActionsView.networkActionCount(clientId))

      const rangeStartPos = (startCheckpointId - 1) * OPTIMISTIC_CHECKPOINT_INTERVAL
      const actionsNeededFromEnd = actionCount - rangeStartPos
      const latestL2 = await httpProvider.getBlockNumber()
      const eventsContract = new Contract(CAW_ACTIONS_ADDRESS, cawActionsAbi as any, httpProvider)
      // Bind a second contract to the ERC-1271 sibling if deployed. The sibling
      // emits ActionsProcessed from its own address for every ERC-1271 batch, and
      // those events must be merged into the reconstruction stream so checkpoints
      // that span both ECDSA and ERC-1271 batches produce the correct hash chain.
      const eventsContractERC1271 = CAW_ACTIONS_ERC1271_ADDRESS
        ? new Contract(CAW_ACTIONS_ERC1271_ADDRESS, cawActionsAbi as any, httpProvider)
        : null

      const CHUNK = 50_000
      // processedEvents items carry .address so the decode dispatch can branch on
      // which contract emitted the event (ECDSA vs ERC-1271 calldata shape).
      let processedEvents: any[] = []
      let scannedActions = 0
      let toBlock = latestL2

      while (scannedActions < actionsNeededFromEnd) {
        const fromBlock = Math.max(0, toBlock - CHUNK + 1)
        // Filter on the indexed networkId topic so we only get this client's
        // batches back — much cheaper than the old "decode every event's
        // bytes to count" approach.
        const batch = await eventsContract.queryFilter(
          eventsContract.filters.ActionsProcessed(clientId),
          fromBlock,
          toBlock,
        )
        let batchERC1271: any[] = []
        if (eventsContractERC1271) {
          batchERC1271 = await eventsContractERC1271.queryFilter(
            eventsContractERC1271.filters.ActionsProcessed(clientId),
            fromBlock,
            toBlock,
          )
        }
        // Merge the two event streams for counting. The address field on each
        // event record identifies which contract emitted it.
        const combined = [...batch, ...batchERC1271]
        for (const ev of combined) {
          const args: any = (ev as any).args
          if (!args) continue
          // The new event carries actionCount directly; no payload decode needed.
          const cnt = Number(args.actionCount ?? args[2] ?? 0)
          scannedActions += cnt
        }
        processedEvents = [...combined, ...processedEvents]
        if (fromBlock === 0) break
        toBlock = fromBlock - 1
      }

      if (processedEvents.length === 0) return null

      // Build a map from txHash → emitting contract address. A single tx calls
      // exactly one entry point (processActions OR processActionsERC1271), so the
      // mapping is 1:1. This is used below to select the correct calldata decoder.
      const txEmitter = new Map<string, string>()
      for (const ev of processedEvents) {
        const txHash: string = ev.transactionHash
        // ev.address is the contract that emitted the event (lowercased by ethers).
        if (!txEmitter.has(txHash)) txEmitter.set(txHash, (ev.address as string).toLowerCase())
      }

      const txHashes = Array.from(txEmitter.keys())
      if (txHashes.length === 0) return null

      type OrderedEntry = {
        blockNumber: number; txIndex: number; calldataPos: number
        action: any; v: number; r: string; s: string
      }
      const orderedEntries: OrderedEntry[] = []

      for (const txHash of txHashes) {
        const tx = await httpProvider.getTransaction(txHash)
        if (!tx) {
          console.error(`[Reconstruct] Could not fetch tx ${txHash}`)
          return null
        }

        const emitter = txEmitter.get(txHash)!
        // Cast to string (not the "" literal) so TS doesn't narrow to never
        // when CAW_ACTIONS_ERC1271_ADDRESS is typed as "" as const.
        const erc1271Addr: string = CAW_ACTIONS_ERC1271_ADDRESS
        const isERC1271 = erc1271Addr !== '' && emitter === erc1271Addr.toLowerCase()

        if (isERC1271) {
          // ---- ERC-1271 path ----
          // Calldata shape: processActionsERC1271(validatorId, packedActions, bytes[] sigs, bytes32[] rs, ...)
          // For each group g, rs[g] == keccak256(sigs[g]) is enforced on-chain.
          // In _updateHashChain, ba.r = rs[g] is folded once per action in the group
          // (CawActions.sol:981,1183 — same group-r-reuse pattern as ECDSA).
          // So for each action i in group g, allR[i] = rs[g].
          let decodedERC1271: any
          try {
            decodedERC1271 = packedIface.decodeFunctionData('processActionsERC1271', tx.data)
          } catch (err) {
            console.error(`[Reconstruct] ERC-1271 calldata decode failed for tx ${txHash}: ${err instanceof Error ? err.message : String(err)}`)
            return null
          }
          const packedHexERC1271: string = decodedERC1271[1]
          const sigsArr: string[] = Array.from(decodedERC1271[2] as string[])
          const rsArr: string[] = Array.from(decodedERC1271[3] as string[])

          // Sanity-check: rs[g] must equal keccak256(sigs[g]). The on-chain
          // contract already enforces this, but verifying client-side catches
          // local calldata corruption before it propagates to archive submission.
          for (let g = 0; g < sigsArr.length; g++) {
            const expected = keccak256(sigsArr[g])
            if (expected !== rsArr[g]) {
              console.error(`[Reconstruct] ERC-1271 rs[${g}] mismatch in tx ${txHash}: got ${rsArr[g]}, want ${expected}`)
              return null
            }
          }

          const packedBufERC1271 = new Uint8Array(
            (packedHexERC1271.startsWith('0x') ? packedHexERC1271.slice(2) : packedHexERC1271)
              .match(/.{2}/g)!.map(b => parseInt(b, 16))
          )
          const unpackedERC1271 = unpackActions(packedBufERC1271)

          // Assign rs[g] to each action in group g. The packed-actions wire format
          // groups actions identically to the sig groups in sigsArr/rsArr: group g
          // is a contiguous run of actions sharing the same sender. We walk the
          // actions tracking group boundaries by senderId transitions (each group
          // has a unique sender per CawActionsERC1271's _processGroup invariant).
          // Group size can be 1 or more; we track by sender change to align.
          let gIdx = 0
          let prevSender = unpackedERC1271.length > 0 ? unpackedERC1271[0].senderId : -1
          for (let i = 0; i < unpackedERC1271.length; i++) {
            const a = unpackedERC1271[i]
            // Advance group index when sender changes (each group = one sender).
            if (i > 0 && a.senderId !== prevSender) {
              gIdx++
              prevSender = a.senderId
            }
            if (a.networkId !== clientId) continue
            const groupR: string = rsArr[gIdx]
            orderedEntries.push({
              blockNumber: tx.blockNumber!,
              txIndex: tx.index!,
              calldataPos: i,
              action: {
                actionType: a.actionType,
                senderId: a.senderId,
                receiverId: a.receiverId,
                receiverCawonce: a.receiverCawonce,
                networkId: a.networkId,
                cawonce: a.cawonce,
                recipients: a.recipients,
                amounts: a.amounts.map((x: any) => BigInt(x)),
                text: a.text,
              },
              v: 0,
              r: groupR,
              s: '0x' + '00'.repeat(32),
            })
          }
        } else {
          // ---- ECDSA path (processActions / safeProcessActions) ----
          let decoded: any
          try {
            decoded = packedIface.decodeFunctionData('processActions', tx.data)
          } catch {
            // May be safeProcessActions — same arg shape, different selector.
            try {
              decoded = packedIface.decodeFunctionData('safeProcessActions', tx.data)
            } catch (err) {
              console.error(`[Reconstruct] ECDSA calldata decode failed for tx ${txHash}: ${err instanceof Error ? err.message : String(err)}`)
              return null
            }
          }
          const packedHex: string = decoded[1]
          const sigsHex: string = decoded[2]

          const packedBuf = new Uint8Array((packedHex.startsWith('0x') ? packedHex.slice(2) : packedHex).match(/.{2}/g)!.map(b => parseInt(b, 16)))
          const unpackedActions = unpackActions(packedBuf)

          const sigBytes = new Uint8Array((sigsHex.startsWith('0x') ? sigsHex.slice(2) : sigsHex).match(/.{2}/g)!.map(b => parseInt(b, 16)))

          // Wire format is grouped: [uint16 numGroups][per group: 2-byte size +
          // 65-byte sig], with batch groups sharing one (v,r,s) across multiple
          // actions. Expand to one entry per action so each action gets the r
          // value the on-chain hash chain folded in (see CawActions.sol's
          // _updateHashChain — batch groups reuse the group's r per action).
          const perActionSigs = unpackPerActionSigs(sigBytes, unpackedActions.length)

          for (let i = 0; i < unpackedActions.length; i++) {
            const a = unpackedActions[i]
            if (a.networkId !== clientId) continue
            const sig = perActionSigs[i]
            orderedEntries.push({
              blockNumber: tx.blockNumber!,
              txIndex: tx.index!,
              calldataPos: i,
              action: {
                actionType: a.actionType,
                senderId: a.senderId,
                receiverId: a.receiverId,
                receiverCawonce: a.receiverCawonce,
                networkId: a.networkId,
                cawonce: a.cawonce,
                recipients: a.recipients,
                amounts: a.amounts.map((x: any) => BigInt(x)),
                text: a.text,
              },
              v: sig.v,
              r: sig.r,
              s: sig.s,
            })
          }
        }
      }

      // Sort by (blockNumber, transactionIndex, calldataPosition)
      orderedEntries.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber
        if (a.txIndex !== b.txIndex) return a.txIndex - b.txIndex
        return a.calldataPos - b.calldataPos
      })

      const firstGlobalPos = actionCount - orderedEntries.length
      const localStart = rangeStartPos - firstGlobalPos
      const rangeEntries = orderedEntries.slice(localStart, localStart + totalActionsNeeded)

      if (rangeEntries.length !== totalActionsNeeded) {
        console.error(`[Reconstruct] Only ${rangeEntries.length}/${totalActionsNeeded} actions for checkpoints ${startCheckpointId}..${endCheckpointId}`)
        return null
      }

      const allActions = rangeEntries.map(e => ({
        actionType: Number(e.action.actionType),
        senderId: Number(e.action.senderId),
        receiverId: Number(e.action.receiverId),
        receiverCawonce: Number(e.action.receiverCawonce),
        networkId: Number(e.action.networkId),
        cawonce: Number(e.action.cawonce),
        recipients: Array.from(e.action.recipients).map(Number),
        amounts: Array.from(e.action.amounts).map((a: any) => BigInt(a)),
        text: e.action.text,
      }))
      const allR = rangeEntries.map(e => e.r)

      // Pack the actions
      const packed = packActions(allActions.map(a => ({
        actionType: a.actionType,
        senderId: a.senderId,
        receiverId: a.receiverId,
        receiverCawonce: a.receiverCawonce,
        networkId: a.networkId,
        cawonce: a.cawonce,
        recipients: a.recipients,
        amounts: a.amounts.map((x: any) => BigInt(x)),
        text: a.text,
      })))

      // Verify and compute hash chain per checkpoint
      const hashCheckAbi = ['function networkHashAtCheckpoint(uint32,uint256) view returns (bytes32)']
      const actionsView = new Contract(CAW_ACTIONS_ADDRESS, hashCheckAbi, httpProvider)
      const prevHash = startCheckpointId === 1
        ? '0x' + '00'.repeat(32)
        : await actionsView.networkHashAtCheckpoint(clientId, startCheckpointId - 1)
      const expectedFinalHash = await actionsView.networkHashAtCheckpoint(clientId, endCheckpointId)

      const actionSlices = getPackedActionSlices(packed)
      const checkpointHashes: string[] = []
      let computedHash = prevHash

      for (let i = 0; i < totalActionsNeeded; i++) {
        const actionHash = keccak256(bytesToHex(actionSlices[i]))
        computedHash = keccak256(solidityPacked(['bytes32', 'bytes32', 'bytes32'], [computedHash, allR[i], actionHash]))

        // Record hash at checkpoint boundaries
        if ((i + 1) % OPTIMISTIC_CHECKPOINT_INTERVAL === 0) {
          checkpointHashes.push(computedHash)
        }
      }

      if (computedHash !== expectedFinalHash) {
        console.error(`[Reconstruct] Hash chain mismatch! Computed ${computedHash} vs on-chain ${expectedFinalHash}`)
        return null
      }

      return { allActions, allR, packedBytes: packed, checkpointHashes, entryHash: prevHash }
    }

    // Last-ran timestamp for autoFinalizeSubmissions. The replication loop
    // ticks every replicationInterval (60s default) but finalization only
    // needs to run hourly — see the gate inside the loop body.
    let lastFinalizeRunAt = 0

    /**
     * Optimistic replication loop: submits checkpoint data directly to L2b
     * archive contract with stake-based security instead of LZ fees per batch.
     */
    async function optimisticReplicationLoop() {
      try {
        // Loud reminder every cycle when corruption is active, so this can't
        // silently keep producing fraud after being left on by accident.
        if (CORRUPT_REPLICATION) {
          console.warn(
            `[OptimisticReplication] ⚠️  CORRUPT_REPLICATION=true CORRUPT_MODE=${CORRUPT_MODE} — ` +
            `every submission this cycle will be FRAUDULENT and slashable. ` +
            `Unset both env vars and restart to disable.`
          )
        }
        const { archiveRead: archive, archiveWrite: archiveW, l2bSubmitter: w } = await getL2bContracts()

        // 1. Find networks needing replication FIRST — if none, nothing to do
        //    and we shouldn't prod the operator about stake either.
        //
        //    Per-validator config via REPLICATE_NETWORK_IDS env (comma-separated
        //    list of network IDs this validator replicates). Replaces the old
        //    on-chain CCM replication registry — operators decide independently
        //    which networks they archive, and the chain doesn't need to know.
        const replicateNetworkIds = (process.env.REPLICATE_NETWORK_IDS ?? process.env.REPLICATE_CLIENT_IDS ?? '')
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
          .map(s => Number(s))
          .filter(n => Number.isFinite(n) && n > 0)
        if (process.env.REPLICATE_CLIENT_IDS && !process.env.REPLICATE_NETWORK_IDS) {
          console.warn('[validator] REPLICATE_CLIENT_IDS is deprecated; rename to REPLICATE_NETWORK_IDS')
        }
        if (replicateNetworkIds.length === 0) return

        // 1a. Filter out networks whose storage chain is L1 (mainnet/Sepolia).
        //
        //    Why: archiving L1 actions to another chain is pointless — L1 is
        //    already the most permanent chain in the stack. The deploy script
        //    intentionally does NOT include L1 in L2_CHAIN_KEYS, so there's no
        //    CawChallengeRelay_L1 to read CawActions_L1.networkHashAtCheckpoint
        //    and ship a fraud proof. Anyone wanting to verify L1 actions reads
        //    the canonical chain directly.
        //
        //    The validator can't see Network.storageChainEid in the DB (not
        //    cached today), and we don't want to add a per-cycle CCM RPC just
        //    for this guard. Operators with L1-storage networks should set
        //    SKIP_L1_REPLICATE_NETWORK_IDS=N,M to silence the loop for those
        //    ids — without it, the loop tries to ship hashes from the wrong
        //    chain and the archive submission fails per cycle.
        const skipL1Ids = new Set(
          (process.env.SKIP_L1_REPLICATE_NETWORK_IDS ?? process.env.SKIP_L1_REPLICATE_CLIENT_IDS ?? '')
            .split(',').map(s => s.trim()).filter(Boolean)
            .map(s => Number(s)).filter(n => Number.isFinite(n) && n > 0)
        )
        if (process.env.SKIP_L1_REPLICATE_CLIENT_IDS && !process.env.SKIP_L1_REPLICATE_NETWORK_IDS) {
          console.warn('[validator] SKIP_L1_REPLICATE_CLIENT_IDS is deprecated; rename to SKIP_L1_REPLICATE_NETWORK_IDS')
        }
        const eligibleNetworkIds = replicateNetworkIds.filter(id => !skipL1Ids.has(id))
        if (skipL1Ids.size > 0 && !skippedL1ClientsWarned) {
          console.log(
            `[OptimisticReplication] Skipping L1-storage network(s) ${[...skipL1Ids].join(', ')} ` +
            `— L1-stored actions don't need archiving (L1 is already canonical).`
          )
          skippedL1ClientsWarned = true
        }
        if (eligibleNetworkIds.length === 0) return
        const clients = eligibleNetworkIds.map(id => ({ id }))

        // 2. Check stake. Auto-restake is OFF BY DEFAULT: a stake drop during
        //    live operation almost always means a slash — silently topping
        //    up bleeds funds while hiding the underlying cause. Opt in with
        //    AUTO_RESTAKE=true for local dev / known-honest test runs.
        //
        //    Under-staked + opt-out: print a clear CLI setup instruction
        //    ONCE per process lifetime, then skip quietly on subsequent
        //    cycles so we don't flood logs every 30s.
        const currentStake = BigInt(await archive.stakes(w.getAddress()))
        if (currentStake < OPTIMISTIC_MIN_STAKE) {
          if (process.env.AUTO_RESTAKE !== 'true') {
            if (!underStakedWarned) {
              const archiveAddr = OPTIMISTIC_ARCHIVE_ADDRESS
              const amountEth = (Number(OPTIMISTIC_INITIAL_DEPOSIT) / 1e18).toFixed(2)
              const role = REPLICATOR_PRIVATE_KEY ? 'REPLICATOR' : 'VALIDATOR'
              console.warn(
                `\n` +
                `┌─ Replication paused: under-staked ─────────────────────┐\n` +
                `│ Your ${role} wallet (${w.getAddress().slice(0,10)}…) has ${ethers_formatStake(currentStake)} ETH\n` +
                `│ staked on archive ${archiveAddr.slice(0,10)}…, but the\n` +
                `│ minimum is ${ethers_formatStake(OPTIMISTIC_MIN_STAKE)} ETH.\n` +
                `│\n` +
                `│ To replicate, deposit stake first:\n` +
                `│   cd client\n` +
                `│   npx tsx scripts/archive-deposit.ts ${role} ${amountEth}\n` +
                `│\n` +
                `│ (or set AUTO_RESTAKE=true to auto-top-up every cycle)\n` +
                `└────────────────────────────────────────────────────────┘`
              )
              underStakedWarned = true
            }
            return
          }
          console.log(`[OptimisticReplication] Stake ${currentStake} < MIN_STAKE ${OPTIMISTIC_MIN_STAKE}, depositing ${OPTIMISTIC_INITIAL_DEPOSIT}...`)
          const tx = await archiveW.deposit({ value: OPTIMISTIC_INITIAL_DEPOSIT })
          const receipt = await tx.wait()
          console.log(`[OptimisticReplication] Deposited ${OPTIMISTIC_INITIAL_DEPOSIT} wei as stake. tx: ${receipt?.hash}`)
        } else {
          // Reset so a future slash can re-trigger the prompt once.
          underStakedWarned = false
        }

        // Backpressure: don't submit more while we already have pending
        // submissions — if an earlier one turns out to be fraudulent, a slash
        // will cascade through ALL pending and cost the stake regardless of
        // how many we queued. For honest operation this bounds exposure
        // during LZ/monitor latency windows; for fraud-testing it prevents
        // the runaway "pre-slash spam" we kept observing.
        // V2 CawActionsArchive.MAX_PENDING_PER_VALIDATOR = 16 (on-chain hard cap).
        // The env default of 1 is intentionally conservative — operators raising
        // MAX_PENDING_SUBMISSIONS must keep it at or below 16 or the next
        // submitReplication() call will revert with TooManyPendingSubmissions.
        const maxPending = Number(process.env.MAX_PENDING_SUBMISSIONS || '1')
        const pending = Number(await archive.pendingCount(w.getAddress()))
        if (pending >= maxPending) {
          console.log(`[OptimisticReplication] pendingCount=${pending} >= MAX_PENDING_SUBMISSIONS=${maxPending} — waiting for existing submission(s) to finalize or slash before queueing more`)
          return
        }


        const httpProvider = replicationHttpProvider
        const cawActionsViewAbi = ['function clientActionCount(uint32) view returns (uint256)']
        const cawActionsView = new Contract(CAW_ACTIONS_ADDRESS, cawActionsViewAbi, httpProvider)

        for (const client of clients) {
          try {
            const actionCount = Number(await cawActionsView.clientActionCount(client.id))
            const totalCheckpoints = Math.floor(actionCount / OPTIMISTIC_CHECKPOINT_INTERVAL)
            if (totalCheckpoints === 0) continue

            // 3. Find unreplicated checkpoint range on L2b archive
            let startCheckpointId = 0
            for (let cp = 1; cp <= totalCheckpoints; cp++) {
              const claimed = Number(await archive.checkpointClaimed(client.id, cp))
              if (claimed === 0) {
                startCheckpointId = cp
                break
              }
            }

            if (startCheckpointId === 0) continue // Fully caught up

            // Find consecutive available checkpoints (max 256 per contract limit)
            let endCheckpointId = startCheckpointId
            const maxEnd = Math.min(totalCheckpoints, startCheckpointId + 255)
            for (let cp = startCheckpointId + 1; cp <= maxEnd; cp++) {
              const claimed = Number(await archive.checkpointClaimed(client.id, cp))
              if (claimed !== 0) break
              endCheckpointId = cp
            }

            // Verify range is still available (atomic check)
            const rangeAvailable = await archive.isRangeAvailable(client.id, startCheckpointId, endCheckpointId)
            if (!rangeAvailable) {
              console.log(`[OptimisticReplication] Network ${client.id}: range ${startCheckpointId}..${endCheckpointId} no longer available, skipping`)
              continue
            }

            let numCheckpoints = endCheckpointId - startCheckpointId + 1

            // Dynamic batch sizing. Budget applies to packedActions bytes only.
            // The actual submission tx carries packed + r[] + entryHash + ABI
            // overhead ≈ packed * 1.5. More importantly, `slashIncoherentRoot`
            // (the Mode A slash) ALSO echoes the same data back in its
            // calldata, so the slash tx is as big as the submission tx. RPC
            // providers (Infura, Arbitrum public) typically reject single-tx
            // bodies above ~50-60KB as "oversized"/"unparseable". Stay well
            // under so both submit AND slash txs fit.
            //   packed(30KB) * 1.5 ≈ 45KB tx → fits
            const L2B_CALLDATA_LIMIT = 30_000

            console.log(`[OptimisticReplication] Network ${client.id}: attempting checkpoints ${startCheckpointId}..${endCheckpointId} (${numCheckpoints})`)

            // 4. Reconstruct data from L2 events — try the full range first
            let data = await reconstructCheckpointData(client.id, startCheckpointId, endCheckpointId)
            if (!data) {
              console.error(`[OptimisticReplication] Failed to reconstruct data for network ${client.id} checkpoints ${startCheckpointId}..${endCheckpointId}`)
              continue
            }

            // Trim if payload is too large for L2b calldata
            while (data.packedBytes.length > L2B_CALLDATA_LIMIT && numCheckpoints > 1) {
              numCheckpoints = Math.max(1, Math.floor(numCheckpoints * 0.7)) // shrink by 30%
              endCheckpointId = startCheckpointId + numCheckpoints - 1
              console.log(`[OptimisticReplication] Trimming to ${numCheckpoints} checkpoints (${startCheckpointId}..${endCheckpointId}, payload was ${data.packedBytes.length} bytes)`)
              data = await reconstructCheckpointData(client.id, startCheckpointId, endCheckpointId)
              if (!data) break
            }

            if (!data) {
              console.error(`[OptimisticReplication] Failed to reconstruct data after trimming for network ${client.id}`)
              continue
            }

            const totalActions = numCheckpoints * OPTIMISTIC_CHECKPOINT_INTERVAL
            console.log(`[OptimisticReplication] Network ${client.id}: submitting checkpoints ${startCheckpointId}..${endCheckpointId} (${numCheckpoints} checkpoints, ${totalActions} actions, ${data.packedBytes.length} bytes)`)

            console.log(`[OptimisticReplication] Hash chain verified for network ${client.id} checkpoints ${startCheckpointId}..${endCheckpointId}`)

            // 5. Build merkle tree over checkpoint hashes
            const checkpointIds = Array.from(
              { length: numCheckpoints },
              (_, i) => startCheckpointId + i
            )
            let { root: merkleRoot } = buildCheckpointMerkleTree(checkpointIds, data.checkpointHashes)
            console.log(`[OptimisticReplication] Merkle root: ${merkleRoot}`)

            // TEST MODE: introduce a specific kind of fraud so the monitor
            // exercises the corresponding detection/slash path.
            if (CORRUPT_REPLICATION && CORRUPT_MODE === 'A') {
              // Mode A: swap the first checkpoint hash locally and rebuild
              // the tree, but leave packedActions + r as the honest
              // L2 values. The committed root no longer derives from the
              // emitted packedActions → slashIncoherentRoot will catch it.
              const badHashes = [...data.checkpointHashes]
              badHashes[0] = keccak256('0x434f525255505445445f5245504c49434154494f4e5f464f525f534c4153485f54455354') // "CORRUPTED_REPLICATION_FOR_SLASH_TEST"
              const corrupted = buildCheckpointMerkleTree(checkpointIds, badHashes)
              console.warn(`[OptimisticReplication] ⚠️  MODE A CORRUPTION: cp ${startCheckpointId} hash ${data.checkpointHashes[0]} → ${badHashes[0]}`)
              console.warn(`[OptimisticReplication] ⚠️  merkleRoot ${merkleRoot} → ${corrupted.root}`)
              data.checkpointHashes = badHashes
              merkleRoot = corrupted.root
            } else if (CORRUPT_REPLICATION && CORRUPT_MODE === 'B') {
              // Mode B: flip one byte inside packedActions, re-fold the hash
              // chain, build a root consistent with the corrupted data. The
              // root IS derivable from packedActions (slashIncoherentRoot
              // would NOT fire), but individual checkpoint hashes now
              // diverge from L2's canonical ones → resolveChallenge fires.
              const badPacked = new Uint8Array(data.packedBytes)
              // Flip byte at action index 0, offset 1 (senderId's high byte)
              // within the 25-byte action layout: [type(1)][senderId(4)]...
              // That change propagates through actionHash → every checkpoint
              // hash from this point forward differs from L2.
              const flipOffset = 2 + 1
              badPacked[flipOffset] = badPacked[flipOffset] ^ 0xff
              const badActionSlices = getPackedActionSlices(badPacked)

              // Refold to get the corrupt-but-consistent checkpoint hashes.
              const prevHash = data.entryHash
              const badCheckpointHashes: string[] = []
              let h = prevHash
              for (let i = 0; i < badActionSlices.length; i++) {
                const actionHash = keccak256(bytesToHex(badActionSlices[i]))
                h = keccak256(solidityPacked(['bytes32', 'bytes32', 'bytes32'], [h, data.allR[i], actionHash]))
                if ((i + 1) % OPTIMISTIC_CHECKPOINT_INTERVAL === 0) badCheckpointHashes.push(h)
              }
              const corrupted = buildCheckpointMerkleTree(checkpointIds, badCheckpointHashes)
              console.warn(`[OptimisticReplication] ⚠️  MODE B CORRUPTION: flipped packedBytes[${flipOffset}]`)
              console.warn(`[OptimisticReplication] ⚠️  merkleRoot ${merkleRoot} → ${corrupted.root}`)
              data.packedBytes = badPacked
              data.checkpointHashes = badCheckpointHashes
              merkleRoot = corrupted.root
            }

            // 6. Submit to L2b archive
            const packedHex = bytesToHex(data.packedBytes)

            // Pre-flight simulation
            try {
              await archiveW.submitReplication.staticCall(
                client.id, startCheckpointId, endCheckpointId,
                packedHex, data.allR, merkleRoot, data.entryHash
              )
            } catch (simErr: any) {
              const reason = simErr?.revert?.args?.[0] || simErr?.reason || simErr?.shortMessage || simErr?.message || 'unknown'
              console.error(`[OptimisticReplication] Pre-flight failed for network ${client.id}: ${reason}`)
              continue
            }

            // Estimate gas and submit
            let gasLimit: bigint
            try {
              const estimated = await archiveW.submitReplication.estimateGas(
                client.id, startCheckpointId, endCheckpointId,
                packedHex, data.allR, merkleRoot, data.entryHash
              )
              gasLimit = (estimated * 120n) / 100n // 20% buffer for L2b
              if (gasLimit > 30_000_000n) gasLimit = 30_000_000n
            } catch (gasErr: any) {
              console.warn(`[OptimisticReplication] estimateGas failed (${gasErr?.shortMessage || gasErr?.message}), using 15M fallback`)
              gasLimit = 15_000_000n
            }

            const tx = await archiveW.submitReplication(
              client.id, startCheckpointId, endCheckpointId,
              packedHex, data.allR, merkleRoot, data.entryHash,
              { gasLimit }
            )
            const receipt = await tx.wait()
            console.log(`[OptimisticReplication] Submitted! tx: ${receipt?.hash} (gas: ${receipt?.gasUsed}/${gasLimit})`)

            // Record analytics
            if (receipt) {
              try {
                await prisma.replicationTx.create({ data: {
                  txHash: receipt.hash,
                  blockNumber: BigInt(receipt.blockNumber),
                  networkId: client.id,
                  checkpointId: startCheckpointId,
                  endCheckpointId,
                  actionCount: numCheckpoints * OPTIMISTIC_CHECKPOINT_INTERVAL,
                  gasUsed: receipt.gasUsed.toString(),
                  gasPrice: receipt.fee ? (receipt.fee / receipt.gasUsed).toString() : '0',
                  ethCost: receipt.fee?.toString() || '0',
                  totalCost: receipt.fee?.toString() || '0',
                  submitter: w.getAddress().toLowerCase(),
                }})
              } catch (e: any) { console.error('[Analytics] Failed to record optimistic replication:', e.message) }
            }
          } catch (err: any) {
            console.error(`[OptimisticReplication] Failed for network ${client.id}: ${formatRpcError(err)}`)
          }
        }

        // 7. Auto-finalize past submissions — gated to once per hour. Even
        // with the checkpoint cutting per-call cost dramatically, there's no
        // reason to scan every replicationInterval (60s default) when the
        // challenge window is days. Hourly hits the right tradeoff between
        // "stake released promptly" and "don't burn RPC for empty scans."
        const FINALIZE_INTERVAL_MS = 60 * 60_000
        if (Date.now() - lastFinalizeRunAt > FINALIZE_INTERVAL_MS) {
          await autoFinalizeSubmissions()
          lastFinalizeRunAt = Date.now()
        }

        // 8. Auto-withdraw excess stake
        await autoWithdrawExcessStake()

      } catch (err: any) {
        console.error(`[OptimisticReplication] Loop error: ${formatRpcError(err)}`)
      }
    }

    /**
     * Chunked event scanner: free RPCs cap eth_getLogs at 50K blocks, but
     * the monitor/finalize cycles look back 86K-115K blocks. Bare
     * archive.queryFilter() over those ranges silently returns empty on
     * publicnode + free Sepolia RPCs, which would let a fraudulent
     * submission slip past the challenge window. Route every wide-range
     * query through scanLogsForward so we always see every event.
     * Audit fix 2026-05-09 (Round 5 backend HIGH-3).
     *
     * Returns parsed events with `.args` shaped like archive.queryFilter
     * results, so callsites are a drop-in swap.
     */
    async function scanArchiveEvents(
      archive: Contract,
      provider: any,
      filter: any,
      fromBlock: number,
      toBlock: number,
    ) {
      const target = await filter
      const rawLogs = await scanLogsForward(
        provider,
        target.address ?? archive.target,
        target.topics ?? [],
        fromBlock,
        toBlock,
      )
      return rawLogs
        .map(log => {
          try {
            const parsed = archive.interface.parseLog({ topics: log.topics as string[], data: log.data })
            if (!parsed) return null
            return {
              args: parsed.args,
              blockNumber: log.blockNumber,
              transactionHash: log.transactionHash,
              logIndex: log.index,
            }
          } catch {
            return null
          }
        })
        .filter((e): e is NonNullable<typeof e> => e !== null)
    }

    /**
     * Finalize submissions whose challenge period has expired.
     *
     * Uses a ChainData checkpoint so each tick scans only NEW blocks since
     * the last run instead of re-scanning ~115k blocks of Arbitrum every
     * time. The eth_getLogs cost without a checkpoint is enormous — 4 days
     * of blocks at every replicationInterval tick was the largest single
     * source of Infura credit burn we measured.
     *
     * Cold start: the checkpoint key may be missing (first run after this
     * code lands, or a fresh DB). Fall back to the original 4-day lookback
     * once, then write the checkpoint so subsequent ticks are cheap.
     */
    async function autoFinalizeSubmissions() {
      try {
        const { archiveRead: archive, archiveWrite: archiveW, l2bProvider: provider, l2bSubmitter: w } = await getL2bContracts()

        const latestBlock = await provider!.getBlockNumber()
        const checkpointKey = `optimistic-finalize:${w.getAddress().toLowerCase()}:last-block`
        const cp = await prisma.chainData.findUnique({ where: { key: checkpointKey } })
        // ~12s/block on Arbitrum = ~28800 blocks/day. 4-day cold-start lookback.
        const cold = !cp
        const fromBlock = cp
          ? Math.max(0, Number(cp.value) + 1)
          : Math.max(0, latestBlock - 28800 * 4)
        if (cold) console.log(`[OptimisticReplication] Cold-start finalize scan: ${fromBlock}..${latestBlock}`)

        if (fromBlock > latestBlock) {
          // No new blocks since last check. Common case — nothing to do.
          return
        }

        const events = await scanArchiveEvents(
          archive,
          provider,
          archive.filters.SubmissionCreated(null, w.getAddress()),
          fromBlock,
          latestBlock,
        )

        for (const ev of events) {
          const args: any = ev.args
          if (!args) continue
          const submissionId = Number(args[0] || args.submissionId)

          try {
            const sub = await archive.getSubmission(submissionId)
            const status = Number(sub[6]) // status enum: 0=PENDING, 1=FINALIZED, 2=SLASHED
            if (status !== 0) continue // Not pending

            const finalizedAt = Number(sub[5])
            const now = Math.floor(Date.now() / 1000)
            if (now < finalizedAt) continue // Challenge period still active

            console.log(`[OptimisticReplication] Finalizing submission ${submissionId}...`)
            const tx = await archiveW.finalizeSubmission(submissionId)
            const receipt = await tx.wait()
            console.log(`[OptimisticReplication] Finalized submission ${submissionId}. tx: ${receipt?.hash}`)
          } catch (err: any) {
            // Already finalized or slashed — not an error
            if (err?.reason?.includes('Not pending')) continue
            console.error(`[OptimisticReplication] Failed to finalize submission ${submissionId}: ${err?.shortMessage || err?.message}`)
          }
        }

        // Advance the checkpoint regardless of whether we found events. The
        // next tick should resume from latestBlock+1 either way; failures
        // above don't invalidate the scan range we already covered.
        await prisma.chainData.upsert({
          where: { key: checkpointKey },
          create: { key: checkpointKey, value: latestBlock as any },
          update: { value: latestBlock as any },
        })
      } catch (err: any) {
        console.error(`[OptimisticReplication] Auto-finalize error: ${err?.shortMessage || err?.message}`)
      }
    }

    /**
     * Withdraw excess stake when no pending submissions remain and stake > 3x minimum.
     */
    async function autoWithdrawExcessStake() {
      try {
        const { archiveRead: archive, archiveWrite: archiveW, l2bSubmitter: w } = await getL2bContracts()

        const pending = Number(await archive.pendingCount(w.getAddress()))
        if (pending > 0) return // Can't withdraw with pending submissions

        const currentStake = BigInt(await archive.stakes(w.getAddress()))
        const threshold = OPTIMISTIC_MIN_STAKE * 3n

        if (currentStake <= threshold) return

        const withdrawAmount = currentStake - OPTIMISTIC_MIN_STAKE * 2n // Keep 2x MIN_STAKE as buffer
        if (withdrawAmount <= 0n) return

        console.log(`[OptimisticReplication] Withdrawing excess stake: ${withdrawAmount} wei (keeping ${currentStake - withdrawAmount} wei)`)
        const tx = await archiveW.withdraw(withdrawAmount)
        const receipt = await tx.wait()
        console.log(`[OptimisticReplication] Withdrew ${withdrawAmount} wei. tx: ${receipt?.hash}`)
      } catch (err: any) {
        console.error(`[OptimisticReplication] Auto-withdraw error: ${err?.shortMessage || err?.message}`)
      }
    }

    /**
     * Monitor other validators' optimistic submissions for fraud.
     * Checks that submitted checkpoint hashes match L2's on-chain hashes.
     * Logs warnings on mismatch (actual challenge submission is a follow-up).
     */
    async function monitorOptimisticSubmissions() {
      try {
        // Use the MONITOR wallet here so that a separate REPLICATOR_PRIVATE_KEY
        // submitter's submissions are not skipped as "our own" — the monitor
        // wants to challenge them during the slash test.
        const { archiveRead: archive, l2bProvider: provider, l2bMonitor: w } = await getL2bContracts()

        const latestBlock = await provider!.getBlockNumber()
        // Look back ~3 days of blocks
        const fromBlock = Math.max(0, latestBlock - 28800 * 3)

        // Query ALL SubmissionCreated events (not just ours)
        const events = await scanArchiveEvents(
          archive,
          provider,
          archive.filters.SubmissionCreated(),
          fromBlock,
          latestBlock,
        )

        const httpProvider = replicationHttpProvider
        const hashCheckAbi = ['function networkHashAtCheckpoint(uint32,uint256) view returns (bytes32)']
        const actionsView = new Contract(CAW_ACTIONS_ADDRESS, hashCheckAbi, httpProvider)

        // Persistent cache of submissions whose status is permanently
        // resolved (slashed / finalized / invalidated). Each monitor
        // cycle previously did a getSubmission view call for every
        // submission in the 3-day window — ~50 view calls per cycle
        // even when nothing had changed. Once a submission is
        // status !== 0 it stays that way, so we skip the view call
        // entirely on subsequent cycles.
        const resolvedRow = await prisma.chainData.findUnique({
          where: { key: 'validator_monitor_resolved' },
        })
        const resolvedSet = new Set<number>(
          (resolvedRow?.value as { ids?: number[] })?.ids ?? [],
        )
        const newlyResolved: number[] = []

        for (const ev of events) {
          const args: any = ev.args
          if (!args) continue

          const submissionId = Number(args[0] || args.submissionId)
          const submitter = args[1] || args.submitter
          const clientId = Number(args[2] || args.networkId)
          const startCp = Number(args[3] || args.startCheckpointId)
          const endCp = Number(args[4] || args.endCheckpointId)

          // Skip our own submissions
          if (submitter.toLowerCase() === w.getAddress().toLowerCase()) continue

          // Skip submissions we already know are resolved (saves a
          // getSubmission view call per cycle).
          if (resolvedSet.has(submissionId)) continue

          // Check if still pending
          let merkleRoot: string
          try {
            const sub = await archive.getSubmission(submissionId)
            const status = Number(sub[6])
            if (status !== 0) {
              // Cache this for future cycles.
              newlyResolved.push(submissionId)
              continue
            }
            merkleRoot = sub[1] // bytes32 merkleRoot
          } catch { continue }

          // Set up contract handles once per submission.
          const resolveAbi = [
            'function challengeDelivered(uint256, uint256) view returns (bool)',
            'function challengeHash(uint256, uint256) view returns (bytes32)',
            'function resolveChallenge(uint256 submissionId, uint256 checkpointId, bytes32 claimedHash, bytes32[] merkleProof)',
            'function slashIncoherentRoot(uint256 submissionId, bytes packedActions, bytes32[] r, bytes32 entryHash)',
          ]
          // Reuse the L2b monitor signer — same key, same provider as a fresh Wallet.
          const { l2bMonitor: resolveSigner } = await getL2bContracts()
          const archiveW = new Contract(OPTIMISTIC_ARCHIVE_ADDRESS, resolveAbi, resolveSigner.asEthersSigner())
          const archiveResolveRead = new Contract(OPTIMISTIC_ARCHIVE_ADDRESS, resolveAbi, l2bProvider)

          // --- Build the SUBMITTER'S OWN claimed view of this range ------
          //
          // For Mode B detection: an honest-looking submission's packedActions
          // hash up to its committed merkle root. If those hashes don't match
          // L2's canonical networkHashAtCheckpoint, the submitter committed to
          // invented actions — which we can prove by supplying their own
          // claimedHash + a valid proof in their own tree.
          //
          // If rebuilding from ActionsArchived produces a root that DOESN'T
          // match sub.merkleRoot, this is Mode A (incoherent root). Current
          // resolveChallenge cannot slash it; flagged for the dedicated
          // slashIncoherentRoot path.
          let submitterHashes: string[] | null = null
          let submitterTree: ReturnType<typeof buildCheckpointMerkleTree> | null = null
          let modeA = false
          try {
            const numCp = endCp - startCp + 1
            const archivedEvents = await scanArchiveEvents(
              archive,
              provider,
              archive.filters.ActionsArchived(submissionId),
              fromBlock, latestBlock,
            )
            const archivedEv: any = archivedEvents[0]
            if (!archivedEv) throw new Error('ActionsArchived event missing')
            // The new event carries hashes only — fetch packedActions + r[] +
            // entryHash from the originating tx's calldata.
            const submitted = await decodeArchiveSubmissionFromTx(l2bProvider!, archivedEv.transactionHash)
            if (!submitted) throw new Error('Could not decode submitReplication tx')
            const submitterPackedHex = submitted.packedActions
            const submitterR = submitted.r.map(x => String(x))

            const entryHash = startCp === 1
              ? '0x' + '00'.repeat(32)
              : await actionsView.networkHashAtCheckpoint(clientId, startCp - 1)

            const packedBytes = Buffer.from(submitterPackedHex.slice(2), 'hex')
            submitterHashes = foldCheckpointHashes(
              new Uint8Array(packedBytes), submitterR, entryHash, startCp, endCp, OPTIMISTIC_CHECKPOINT_INTERVAL,
            )
            if (!submitterHashes) throw new Error('submitter action count mismatch')

            const checkpointIds = Array.from({ length: numCp }, (_, i) => startCp + i)
            submitterTree = buildCheckpointMerkleTree(checkpointIds, submitterHashes)
            if (submitterTree.root.toLowerCase() !== merkleRoot.toLowerCase()) {
              modeA = true
            }
          } catch (e: any) {
            console.warn(`[Monitor] Could not rebuild submitter tree for submission ${submissionId}: ${e?.message}`)
          }

          // --- Resolve previously-relayed challenges -------------------
          // LZ has delivered correctHash into the archive; we now need to
          // provide the submitter's claimedHash + a merkle proof in their
          // tree. If submitterTree is null (couldn't rebuild) we can't
          // proceed — this cycle will retry next round.
          //
          // Run per-cp resolve in parallel. Once any resolveChallenge
          // lands, the archive flips the submission to SLASHED and all
          // later resolves in this batch revert with "Not pending" —
          // harmless, just caught and logged. This is still vastly
          // better than serial: one honest monitor race can win in
          // ~1 block instead of waiting through a serial queue.
          const resolveOne = async (cpId: number) => {
            try {
              const delivered = await archiveResolveRead.challengeDelivered(submissionId, cpId)
              if (!delivered) return
              if (!submitterHashes || !submitterTree) return

              const correctHash = await archiveResolveRead.challengeHash(submissionId, cpId)
              const cpIndex = cpId - startCp
              const claimedHash = submitterHashes[cpIndex]
              const proof = submitterTree.getProof(cpIndex)

              if (correctHash.toLowerCase() === claimedHash.toLowerCase()) {
                console.log(`[Monitor] Challenge for submission ${submissionId} cp ${cpId}: submitter's hash matches L2 (no fraud on this cp)`)
                return
              }

              const claimedLock = await tryClaimChallengeLock('resolve', submissionId, cpId, w.getAddress().toLowerCase(), 10 * 60 * 1000)
              if (!claimedLock) return

              console.log(`[Monitor] Resolving challenge for submission ${submissionId} checkpoint ${cpId}...`)
              try {
                const resolveTx = await archiveW.resolveChallenge(submissionId, cpId, claimedHash, proof, { gasLimit: 500_000 })
                const resolveReceipt = await resolveTx.wait()
                console.log(`[Monitor] SLASHED submission ${submissionId}! tx: ${resolveReceipt?.hash}`)
                await releaseChallengeLock('resolve', submissionId, cpId, 'success', resolveReceipt?.hash)
              } catch (e) {
                await releaseChallengeLock('resolve', submissionId, cpId, 'error')
                throw e
              }
            } catch (resolveErr: any) {
              console.warn(`[Monitor] Error resolving challenge for submission ${submissionId} cp ${cpId}: ${resolveErr?.shortMessage || resolveErr?.message}`)
            }
          }
          // Resolve sequentially. Parallel sends collided on nonces (ethers's
          // provider caches the nonce, so Promise.all-fired txs all grabbed
          // the same one), and anyway the FIRST successful resolve flips the
          // submission to SLASHED and invalidates all of this validator's
          // pending submissions — the remaining cps would revert with
          // "Not pending" regardless. Serial + early exit on slash is both
          // correct and cheaper.
          for (let cpId = startCp; cpId <= endCp; cpId++) {
            await resolveOne(cpId)
            // Re-check status: if the submission flipped to SLASHED, the
            // remaining cps are no-ops. Save the RPC round-trip.
            try {
              const sub2 = await archive.getSubmission(submissionId)
              if (Number(sub2[6]) !== 0) break
            } catch { /* ignore, continue loop */ }
          }

          // --- Detect & relay new fraud challenges ---------------------
          // Collect all fraudulent cps then relay them in one batch LZ
          // message via relayChallengeBatch. The submission-scoped lock
          // ('relayBatch') prevents multiple monitor nodes from each
          // sending their own batch for the same submission.
          const relayBatch = async (cps: number[], reason: string) => {
            if (cps.length === 0) return

            // Filter out cps that already have a challenge delivered.
            const notYetDelivered: number[] = []
            for (const cp of cps) {
              try {
                const delivered = await archiveResolveRead.challengeDelivered(submissionId, cp)
                if (!delivered) notYetDelivered.push(cp)
              } catch { notYetDelivered.push(cp) /* if view fails, try */ }
            }
            if (notYetDelivered.length === 0) return

            const holder = w.getAddress().toLowerCase()
            const lockClaimed = await tryClaimChallengeLock('relayBatch', submissionId, 0, holder, 10 * 60 * 1000)
            if (!lockClaimed) return

            const L2B_EID = 40231
            const relayAbi = [
              'function relayChallengeBatch(uint32 destEid, uint256 submissionId, uint32 networkId, uint256[] checkpointIds) payable',
              'function quoteChallengeBatch(uint32 destEid, uint256 submissionId, uint32 networkId, uint256[] checkpointIds, bool payInLzToken) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))',
            ]
            const relaySigner = requireValidatorSigner({ provider: replicationHttpProvider })
            const relayContract = new Contract(CHALLENGE_RELAY_ADDRESS, relayAbi, relaySigner.asEthersSigner())

            try {
              const quote = await relayContract.quoteChallengeBatch(L2B_EID, submissionId, clientId, notYetDelivered, false)
              // Gas scales with cp count: ~100k base + ~40k per cp on the
              // source chain (endpoint + payload encoding). 200k + 60k/cp
              // with a buffer.
              const gasLimit = 200_000n + 60_000n * BigInt(notYetDelivered.length)
              // LZ fee buffer: 150%, not 120%. Slashing-adjacent path — if
              // the relay tx fails due to a fee underpayment, the challenge
              // doesn't deliver and a fraudulent submission can finalize
              // unchallenged. 50% over the quoted fee covers LZ-fee spikes
              // during destination-chain congestion. Audit fix 2026-05-13
              // (validator V4).
              const relayTx = await relayContract.relayChallengeBatch(
                L2B_EID, submissionId, clientId, notYetDelivered,
                { value: quote.nativeFee * 150n / 100n, gasLimit },
              )
              const relayReceipt = await relayTx.wait()
              console.log(`[Monitor] Challenge batch relayed (${reason}) for submission ${submissionId} cps=[${notYetDelivered.join(',')}]. tx: ${relayReceipt?.hash}`)
              await releaseChallengeLock('relayBatch', submissionId, 0, 'success', relayReceipt?.hash)
            } catch (e) {
              await releaseChallengeLock('relayBatch', submissionId, 0, 'error')
              throw e
            }
          }

          try {
            if (modeA) {
              // Mode A: committed root doesn't even commit to the submitter's
              // own packedActions. Call slashIncoherentRoot which re-hashes
              // the data on-chain and slashes if the rebuilt root differs.
              console.error(
                `[Monitor] MODE A FRAUD (incoherent root) in submission ${submissionId}: ` +
                `committedRoot=${merkleRoot} does not match root built from submitter's own packedActions.`
              )

              const lockHolder = w.getAddress().toLowerCase()
              const claimed = await tryClaimChallengeLock('slashIncoherent', submissionId, 0, lockHolder, 10 * 60 * 1000)
              if (!claimed) continue

              try {
                // Fetch the originating submitReplication tx via ActionsArchived
                // event (chunked scan — free RPCs cap eth_getLogs at 50K blocks),
                // then decode packedActions + r[] from its calldata. The event
                // itself only carries hash commitments now.
                const archivedEvents = await scanArchiveEvents(
                  archive,
                  provider,
                  archive.filters.ActionsArchived(submissionId),
                  fromBlock, latestBlock,
                )
                const archivedEv: any = archivedEvents[0]
                if (!archivedEv) throw new Error('ActionsArchived event missing')
                const submitted = await decodeArchiveSubmissionFromTx(l2bProvider!, archivedEv.transactionHash)
                if (!submitted) throw new Error('Could not decode submitReplication tx')
                const submitterPackedHex = submitted.packedActions
                const submitterR = submitted.r.map(x => String(x))

                // entryHash: honest L2's networkHashAtCheckpoint at startCp-1.
                // If submitter lied about entryHash, the contract's
                // dataCommitment check will fail — but that's Mode B which
                // was caught above, so reaching here means entryHash matched.
                const entryHash = startCp === 1
                  ? '0x' + '00'.repeat(32)
                  : await actionsView.networkHashAtCheckpoint(clientId, startCp - 1)

                console.log(`[Monitor] Calling slashIncoherentRoot(${submissionId})...`)
                // slashIncoherentRoot does: keccak check, full hash-chain
                // fold (per-action), build merkle root. 256 actions → ~5M gas
                // observed; 10M leaves margin for larger batches.
                const slashTx = await archiveW.slashIncoherentRoot(
                  submissionId, submitterPackedHex, submitterR, entryHash,
                  { gasLimit: 10_000_000 },
                )
                const slashReceipt = await slashTx.wait()
                console.log(`[Monitor] Mode A SLASHED submission ${submissionId}! tx: ${slashReceipt?.hash}`)
                await releaseChallengeLock('slashIncoherent', submissionId, 0, 'success', slashReceipt?.hash)
              } catch (e: any) {
                console.error(`[Monitor] slashIncoherentRoot failed for ${submissionId}: ${e?.shortMessage || e?.message}`)
                await releaseChallengeLock('slashIncoherent', submissionId, 0, 'error')
              }
              continue
            }

            if (!submitterHashes) {
              console.warn(`[Monitor] Submission ${submissionId}: no submitter view available — skipping`)
              continue
            }

            // Mode B detection: compare each submitter-claimed checkpoint
            // hash to the canonical L2 value. Collect all mismatches then
            // challenge them in one batch LZ message.
            const fraudulentCps: number[] = []
            for (let i = 0; i < submitterHashes.length; i++) {
              const cpId = startCp + i
              const claimedHash = submitterHashes[i]
              let l2Hash: string
              try {
                l2Hash = await actionsView.networkHashAtCheckpoint(clientId, cpId)
              } catch {
                console.warn(`[Monitor] Could not read L2 hash for checkpoint ${cpId}, skipping`)
                continue
              }
              if (claimedHash.toLowerCase() !== l2Hash.toLowerCase()) {
                console.error(
                  `[Monitor] MODE B FRAUD in submission ${submissionId} cp ${cpId}: ` +
                  `submitterClaimed=${claimedHash} L2=${l2Hash} submitter=${submitter}`
                )
                fraudulentCps.push(cpId)
              }
            }

            if (fraudulentCps.length > 0) {
              try { await relayBatch(fraudulentCps, 'mode B') }
              catch (e: any) { console.error(`[Monitor] Failed to relay batch for submission ${submissionId}: ${e?.shortMessage || e?.message}`) }
            } else {
              console.log(`[Monitor] Submission ${submissionId} verified OK (network ${clientId}, ${startCp}..${endCp}, submitter ${submitter.slice(0, 10)}...)`)
            }
          } catch (err: any) {
            console.warn(`[Monitor] Error verifying submission ${submissionId}: ${err?.shortMessage || err?.message}`)
          }
        }

        // Flush newly-resolved submission IDs to chainData so future
        // cycles skip them. Bounded: only writes when we found new
        // ones; the persisted set monotonically grows but each entry
        // is just an int and submissions don't unresolve.
        if (newlyResolved.length > 0) {
          const merged = Array.from(new Set([...resolvedSet, ...newlyResolved])).sort((a, b) => a - b)
          await prisma.chainData.upsert({
            where: { key: 'validator_monitor_resolved' },
            update: { value: { ids: merged } },
            create: { key: 'validator_monitor_resolved', value: { ids: merged } },
          })
        }
      } catch (err: any) {
        console.error(`[Monitor] Loop error: ${err?.shortMessage || err?.message}`)
      }
    }

    // ================================================================
    // Loop lifecycle and scheduling
    // ================================================================

    // Declare all loops with the watchdog. Timeouts are generous — 3x the
    // typical interval — so transient slowness doesn't trigger a restart,
    // but a truly hung loop will be caught within a few minutes.
    ctx.declareLoop('poll', Math.max(checkInterval * 3, 60_000))
    ctx.declareLoop('optimisticReplication', Math.max(60_000 * 3, 180_000))
    // Monitor can do a lot of work in one cycle: fetch events, rebuild
    // submitter trees, batch-relay challenges, call resolveChallenge, or
    // slashIncoherentRoot. Batch relay is one tx but resolveChallenge
    // still runs per-cp (in parallel). 15-minute timeout covers a burst
    // of several submissions during a live fraud storm without false-
    // positive restarts.
    ctx.declareLoop('monitor', 15 * 60_000)

    // start polling with overlap protection
    let isPolling = false
    const safePollLoop = async () => {
      if (isPolling) {
        console.log('[Validator] Poll cycle still in progress, skipping this interval')
        return
      }
      isPolling = true
      try {
        await pollLoop()
        ctx.heartbeat('poll')
      } catch (err) {
        console.error(err)
      } finally {
        isPolling = false
      }
    }
    // Expose to the module-level trigger so admin "Execute batch now"
    // can wake this loop without waiting for the next setTimeout tick.
    wakePollLoop = safePollLoop

    // Optimistic replication loop (stake-based, direct L2b)
    let isOptimisticReplicating = false
    let optimisticReplicationTimer: ReturnType<typeof setTimeout>
    const safeOptimisticReplicationLoop = async () => {
      if (isOptimisticReplicating) return
      isOptimisticReplicating = true
      try {
        await optimisticReplicationLoop()
        ctx.heartbeat('optimisticReplication')
      } catch (err) {
        console.error('[OptimisticReplication] Unhandled error:', err)
      } finally {
        isOptimisticReplicating = false
      }
    }

    // Monitor loop (checks other validators' submissions for fraud)
    let isMonitoring = false
    let monitorTimer: ReturnType<typeof setTimeout>
    const safeMonitorLoop = async () => {
      if (isMonitoring) return
      isMonitoring = true
      try {
        await monitorOptimisticSubmissions()
        ctx.heartbeat('monitor')
      } catch (err) {
        console.error('[Monitor] Unhandled error:', err)
      } finally {
        isMonitoring = false
      }
    }

    // Load DB settings before first poll (env/config values serve as defaults).
    // Settings are also refreshed at the start of every poll cycle.
    refreshSettings(checkInterval).catch(err => {
      console.error('[Validator] refreshSettings failed, continuing with defaults:', err.message)
    }).then(() => {
      const httpRpcUrlForLog = getL2HttpRpcUrl(l2RpcUrl)
      console.log(`[Validator] Starting validator service with:`);
      console.log(`  - L2 WS RPC: ${redactRpcUrl(l2RpcUrl)}`);
      console.log(`  - L2 HTTP RPC: ${redactRpcUrl(httpRpcUrlForLog)}`);
      console.log(`  - L1 RPC (mainnet): ${redactRpcUrl(ethMainnetRpcUrl)}`);
      console.log(`  - Validator ID: ${validatorId}`);
      console.log(`  - Check Interval: ${liveSettings.checkInterval}ms`);
      console.log(`  - Base Tip: ${liveSettings.validatorBaseTip} CAW`);
      console.log(`  - Replication Interval: ${liveSettings.replicationInterval}ms`);
      console.log(`  - Wallet Address: ${signer.getAddress()}`);

      // Use setTimeout chains instead of setInterval so updated settings take effect immediately
      function schedulePoll() {
        timer = setTimeout(async () => {
          await safePollLoop()
          schedulePoll()
        }, liveSettings.checkInterval)
      }
      function scheduleOptimisticReplication() {
        optimisticReplicationTimer = setTimeout(async () => {
          await safeOptimisticReplicationLoop()
          scheduleOptimisticReplication()
        }, liveSettings.replicationInterval)
      }
      function scheduleMonitor() {
        // Monitor runs less frequently — 5x the replication interval
        monitorTimer = setTimeout(async () => {
          await safeMonitorLoop()
          scheduleMonitor()
        }, liveSettings.replicationInterval * 5)
      }

      safePollLoop()
      schedulePoll()

      console.log('[OptimisticReplication] Starting optimistic replication and monitor loops')
      safeOptimisticReplicationLoop()
      scheduleOptimisticReplication()
      safeMonitorLoop()
      scheduleMonitor()
    })

    return {
      started: Promise.resolve(),
      async stop() {
        clearTimeout(timer)
        clearTimeout(optimisticReplicationTimer)
        clearTimeout(monitorTimer)
        wakePollLoop = null
        // No need to remove handler since it's managed globally
        if (provider) {
          try {
            provider.destroy()
          } catch (e) {
            // Ignore cleanup errors
          }
        }
      },
      stats: async () => {
        const count = await prisma.txQueue.count({ where: { status: 'pending' } })
        return `pending=${count}`
      }
    }
  }
}


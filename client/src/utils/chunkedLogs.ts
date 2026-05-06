// Chunked eth_getLogs walker.
//
// Public RPCs (publicnode, the canonical Sepolia public-fallback, etc.)
// universally reject getLogs requests spanning more than ~50K blocks.
// Even paid tiers cap at 10K-100K depending on the provider. We chunk so
// the same code path works against any backend without operator-tuned
// block ranges.
//
// Two modes:
//
//   scanLogsForward  — ingest every event from `fromBlock` to `toBlock`.
//                       Used by the indexer's historical sync. Misses
//                       nothing; if a chunk fails, we halve and retry,
//                       and only give up after multiple failures (operator
//                       gets a clear error rather than a silent hole).
//
//   scanLogsBackward — find the most recent N events fast, bail as soon
//                       as we walk into an empty window after seeing
//                       events. Used by registry-style lookups where the
//                       answer is concentrated around recent activity.
//
// Both honor a chunk-size config and a max-windows safety net. Callers
// pass `address` + `topics` directly (matches eth_getLogs RPC shape).

import { AbstractProvider, Log } from 'ethers'

export interface ChunkedScanOptions {
  /** Block range per request. Default: 10_000 (works on free RPCs;
   *  paid RPCs handle 50_000+ but the default is safe). */
  chunkBlocks?: number
  /** Hard ceiling on the number of windows we'll iterate. Defaults are
   *  per-direction: 100 forward, 20 backward. Backstop against
   *  pathological cases (range too large) where the loop would spin
   *  for minutes on a free RPC. */
  maxWindows?: number
  /** Optional progress callback fired after every successful window.
   *  Called with the latest fromBlock / toBlock pair so the caller can
   *  log "scanned X..Y, N logs". Don't do heavy work in here — it
   *  blocks the loop. */
  onProgress?: (fromBlock: number, toBlock: number, logsInWindow: number) => void
}

const DEFAULT_CHUNK = 10_000
const DEFAULT_MAX_WINDOWS_FORWARD = 100
const DEFAULT_MAX_WINDOWS_BACKWARD = 20

/**
 * Walk every block from `fromBlock` to `toBlock` inclusive in chunks.
 * Returns logs in chronological order (matches the underlying
 * eth_getLogs ordering within each chunk).
 *
 * Halves the chunk on a single getLogs failure and retries the upper
 * half. If that also fails, throws — losing data on a forward scan
 * would silently desync the indexer, which is much worse than failing
 * loud.
 *
 * If `fromBlock > toBlock` returns []. Caller is responsible for
 * resolving `toBlock = 'latest'` to a concrete number first.
 */
export async function scanLogsForward(
  provider: AbstractProvider,
  addr: string,
  topics: (string | string[] | null)[],
  fromBlock: number,
  toBlock: number,
  opts: ChunkedScanOptions = {},
): Promise<Log[]> {
  if (fromBlock > toBlock) return []

  const chunkBlocks = opts.chunkBlocks ?? DEFAULT_CHUNK
  const maxWindows = opts.maxWindows ?? DEFAULT_MAX_WINDOWS_FORWARD
  const logs: Log[] = []

  let cursor = fromBlock
  let windowsUsed = 0
  while (cursor <= toBlock) {
    if (windowsUsed >= maxWindows) {
      throw new Error(
        `scanLogsForward: hit maxWindows=${maxWindows} at cursor=${cursor} ` +
        `(target=${toBlock}). Increase chunkBlocks or maxWindows in opts.`,
      )
    }
    const chunkEnd = Math.min(cursor + chunkBlocks - 1, toBlock)
    let windowLogs: Log[]
    try {
      windowLogs = await provider.getLogs({ address: addr, topics, fromBlock: cursor, toBlock: chunkEnd })
    } catch (err: any) {
      // Halve the window once. Free RPCs occasionally cap below the
      // requested chunk on a per-request basis (e.g. when the chunk
      // happens to span a high-traffic block).
      const halfEnd = cursor + Math.floor((chunkEnd - cursor) / 2)
      if (halfEnd <= cursor) throw err // can't halve a 1-block window — give up
      try {
        const upper = await provider.getLogs({ address: addr, topics, fromBlock: cursor, toBlock: halfEnd })
        const lower = await provider.getLogs({ address: addr, topics, fromBlock: halfEnd + 1, toBlock: chunkEnd })
        windowLogs = [...upper, ...lower]
      } catch {
        throw err // surface the original error
      }
    }
    logs.push(...windowLogs)
    opts.onProgress?.(cursor, chunkEnd, windowLogs.length)
    cursor = chunkEnd + 1
    windowsUsed++
  }
  return logs
}

/**
 * Walk backward from `toBlock` (or latest) in chunks, returning logs
 * matching the topic filter. Stops as soon as we walk into an empty
 * window AFTER finding at least one event — the typical use case here
 * (registry / mention lookups) is "find the most recent few events"
 * and history is naturally clustered around contract deploy + recent
 * activity, not spread evenly back to genesis.
 *
 * Returns logs in REVERSE chronological order (newest first). Callers
 * that want chronological order should reverse the result.
 */
export async function scanLogsBackward(
  provider: AbstractProvider,
  addr: string,
  topics: (string | string[] | null)[],
  opts: ChunkedScanOptions & { toBlock?: number; fromBlock?: number } = {},
): Promise<Log[]> {
  const chunkBlocks = opts.chunkBlocks ?? DEFAULT_CHUNK
  const maxWindows = opts.maxWindows ?? DEFAULT_MAX_WINDOWS_BACKWARD
  const head = opts.toBlock ?? await provider.getBlockNumber()
  const floor = opts.fromBlock ?? 0
  const logs: Log[] = []
  let foundAny = false
  let toBlock = head

  for (let i = 0; i < maxWindows; i++) {
    const fromBlock = Math.max(floor, toBlock - chunkBlocks + 1)
    let windowLogs: Log[]
    try {
      windowLogs = await provider.getLogs({ address: addr, topics, fromBlock, toBlock })
    } catch {
      // Halve once and try just the upper half (forfeit the lower half
      // rather than spinning forever — backward scans are best-effort
      // by design).
      try {
        const halfStart = fromBlock + Math.floor((toBlock - fromBlock) / 2)
        windowLogs = await provider.getLogs({ address: addr, topics, fromBlock: halfStart, toBlock })
      } catch {
        break
      }
    }
    if (windowLogs.length > 0) foundAny = true
    logs.push(...windowLogs)
    opts.onProgress?.(fromBlock, toBlock, windowLogs.length)
    if (foundAny && windowLogs.length === 0) break
    if (fromBlock === floor) break
    toBlock = fromBlock - 1
  }
  return logs
}

/**
 * Binary-search the earliest block at which `address` has bytecode.
 * Used by backfill scripts to skip the dead range from genesis to the
 * contract's deployment block — on chains with deep history that's a
 * 10M+ block range of empty getLogs calls.
 *
 * Cost: ~log2(head) `eth_getCode` calls (24-25 on Sepolia today).
 * Cheap relative to even a single chunked getLogs scan, and a one-shot
 * cost amortized across the rest of the backfill.
 *
 * Returns 0 if the contract has no code at `head` (never deployed),
 * or the lowest block number where `eth_getCode != 0x`.
 *
 * Caller can override via env (`L1_DEPLOY_BLOCK_HINT` etc.) or CLI flag
 * — this helper is the fallback when no hint is provided.
 */
export async function findContractDeployBlock(
  provider: AbstractProvider,
  address: string,
  head: number,
): Promise<number> {
  // Sanity check: contract must currently have code. If it doesn't, the
  // address was never deployed (or self-destructed) — return 0 so the
  // caller can decide what to do.
  const headCode = await provider.getCode(address, head)
  if (!headCode || headCode === '0x') return 0

  // Standard binary search for the leftmost block where code !== '0x'.
  // Invariant: code(lo) == 0x AND code(hi) != 0x. We know hi=head holds
  // from above; lo=0 is conservatively assumed to have no contract
  // (genesis is 0x for any address that wasn't pre-funded with code).
  let lo = 0
  let hi = head
  while (lo + 1 < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    const code = await provider.getCode(address, mid)
    if (code && code !== '0x') hi = mid
    else lo = mid
  }
  return hi
}

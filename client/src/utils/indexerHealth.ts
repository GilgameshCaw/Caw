// Shared in-memory health snapshot for the RawEventsGatherer indexer.
//
// The gatherer is the producer (records last-scanned block and recent
// throughput each poll); the validator is the consumer (gates its
// "Cawonce already used → failed" branch on indexer freshness before
// declaring a TxQueue dead). Keyed by chainId because a single process
// can host multiple gatherers when an operator runs additional chains.
//
// Cheap by design: a small ring buffer of recent (timestamp, blocksScanned)
// samples and a couple of scalars per chain. No DB hit, no RPC call.

const MAX_SAMPLES = 10

type ChainStats = {
  lastScannedBlock: number
  lastUpdatedAt: number
  // Ring of poll samples used to compute a rolling blocks/sec rate.
  samples: Array<{ atMs: number; blocks: number }>
}

const byChainId = new Map<number, ChainStats>()

function getOrInit(chainId: number): ChainStats {
  let s = byChainId.get(chainId)
  if (!s) {
    s = { lastScannedBlock: 0, lastUpdatedAt: 0, samples: [] }
    byChainId.set(chainId, s)
  }
  return s
}

/**
 * Producer side. Called after each successful poll cycle in the gatherer
 * with the new high-water-mark `lastScannedBlock`. We record the delta
 * since the last call as a throughput sample.
 */
export function recordIndexerProgress(chainId: number, lastScannedBlock: number): void {
  const s = getOrInit(chainId)
  const now = Date.now()
  if (s.lastUpdatedAt > 0 && lastScannedBlock >= s.lastScannedBlock) {
    const blocks = lastScannedBlock - s.lastScannedBlock
    // Only count samples where time actually advanced; otherwise dt=0
    // would blow up the rate calculation below.
    if (now > s.lastUpdatedAt) {
      s.samples.push({ atMs: now, blocks })
      if (s.samples.length > MAX_SAMPLES) s.samples.shift()
    }
  }
  s.lastScannedBlock = lastScannedBlock
  s.lastUpdatedAt = now
}

export type IndexerStats = {
  lastScannedBlock: number
  lastUpdatedAt: number
  /** Blocks per second averaged over the rolling sample window. */
  throughputBlocksPerSec: number
  /** True once we have at least one usable sample. */
  hasSamples: boolean
}

/**
 * Consumer side. Returns a snapshot of the indexer's freshness for
 * `chainId`. Defaults are conservative so callers that get an unknown
 * chainId can still apply a sane fallback (handled by the caller, not
 * here — this stays a pure read).
 */
export function getIndexerStats(chainId: number): IndexerStats {
  const s = byChainId.get(chainId)
  if (!s) {
    return { lastScannedBlock: 0, lastUpdatedAt: 0, throughputBlocksPerSec: 0, hasSamples: false }
  }
  if (s.samples.length === 0) {
    return {
      lastScannedBlock: s.lastScannedBlock,
      lastUpdatedAt: s.lastUpdatedAt,
      throughputBlocksPerSec: 0,
      hasSamples: false,
    }
  }
  // Average over the window: sum(blocks) / (newest.atMs - oldest.atMs).
  // Single-sample case falls back to blocks / (now - lastUpdated) is wrong
  // because we already know the dt for that one sample — use it directly.
  let totalBlocks = 0
  for (const sample of s.samples) totalBlocks += sample.blocks
  const oldest = s.samples[0].atMs
  const newest = s.samples[s.samples.length - 1].atMs
  let dtMs = newest - oldest
  if (s.samples.length === 1 || dtMs <= 0) {
    // Single-sample fallback: assume the lone sample spans the time
    // since the gatherer last booted is unknown — best we can do is
    // declare throughput unknown rather than divide-by-zero. Caller
    // uses fallback.
    return {
      lastScannedBlock: s.lastScannedBlock,
      lastUpdatedAt: s.lastUpdatedAt,
      throughputBlocksPerSec: 0,
      hasSamples: false,
    }
  }
  return {
    lastScannedBlock: s.lastScannedBlock,
    lastUpdatedAt: s.lastUpdatedAt,
    throughputBlocksPerSec: (totalBlocks * 1000) / dtMs,
    hasSamples: true,
  }
}

/** Test-only hook. Wipes all chains. */
export function _resetIndexerHealthForTests(): void {
  byChainId.clear()
}

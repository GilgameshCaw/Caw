// Chain-order helpers for MarketplaceIndexer.
//
// The indexer fetches every marketplace event in a poll window with one
// getLogs call, buckets them by event name and then processes the buckets
// one event type at a time. Within a window that means a later event of an
// earlier-processed type is already in the DB when an earlier event of a
// later-processed type runs. Handlers that update "all rows for X" (e.g.
// PayoutWithdrawn marks every pending payout of a seller withdrawn) must
// leave out rows created by events that come AFTER them on chain.

export interface LogPosition {
  blockNumber: number
  index: number
}

export function logPosition(ev: { blockNumber: number | bigint; index?: number; logIndex?: number }): LogPosition {
  return { blockNumber: Number(ev.blockNumber), index: Number(ev.index ?? ev.logIndex ?? 0) }
}

/** true when `a` comes strictly after `b` on chain */
export function isAfter(a: LogPosition, b: LogPosition): boolean {
  return a.blockNumber > b.blockNumber || (a.blockNumber === b.blockNumber && a.index > b.index)
}

/**
 * Tx hashes of the events in `events` that match `pick` and come strictly
 * after `ref` on chain. Used to exclude rows a later event in the same
 * window already created.
 */
export function txHashesAfter<T extends { blockNumber: number | bigint; index?: number; logIndex?: number; transactionHash: string }>(
  events: T[],
  ref: { blockNumber: number | bigint; index?: number; logIndex?: number },
  pick: (ev: T) => boolean,
): string[] {
  const refPos = logPosition(ref)
  const out: string[] = []
  for (const ev of events) {
    if (!pick(ev)) continue
    if (!isAfter(logPosition(ev), refPos)) continue
    out.push(ev.transactionHash)
  }
  return out
}

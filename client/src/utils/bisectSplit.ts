// Split point for the validator's revert bisection (bisectAndSubmit).
//
// The rows of one API batch are covered by ONE ActionBatch signature:
// CawActions._processBatchSig verifies it over the group's actionCount,
// firstCawonce and the hash of every slice in the group. A sub-batch that
// carries only part of a group recovers a different signer and reverts,
// so bisection must keep each group whole or it marks the group's
// innocent rows failed.
//
// A group is a run of adjacent rows with the same non-null batchGroupKey
// (sender, batchId and batch sig), the same rule buildMultiActionData uses
// to build the grouped sigs. batchId alone can repeat across batches, so
// it is not enough to find a boundary. Rows with no batchId are groups of
// one.

import { batchGroupKey } from './batchGroupKey'

type BisectRow = {
  batchId?: number | null
  signedTx?: string | null
  payload?: any
}

function groupKeyOf(row: BisectRow): string | null {
  const senderId = row.payload?.data?.senderId
  return batchGroupKey({
    senderId: senderId == null ? null : Number(senderId),
    batchId: row.batchId,
    signedTx: row.signedTx,
  })
}

/**
 * Split `entries` at the group boundary closest to the middle, or return
 * null when they are a single group (one row, or one batch group) and
 * can't be split. With no batch groups the split is the same as
 * Math.floor(entries.length / 2).
 */
export function splitAtBatchGroupBoundary<T extends BisectRow>(
  entries: T[],
): [T[], T[]] | null {
  const mid = entries.length / 2
  let best = -1
  let prevKey = entries.length > 0 ? groupKeyOf(entries[0]) : null
  for (let i = 1; i < entries.length; i++) {
    const cur = groupKeyOf(entries[i])
    const sameGroup = cur != null && cur === prevKey
    prevKey = cur
    if (sameGroup) continue
    // Strict < keeps the lower index on a tie, which is Math.floor.
    if (best === -1 || Math.abs(i - mid) < Math.abs(best - mid)) best = i
  }
  if (best === -1) return null
  return [entries.slice(0, best), entries.slice(best)]
}

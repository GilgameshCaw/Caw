import type { PrismaClient } from '@prisma/client'

// Interactive-transaction client type (same shape as the callback arg of
// prisma.$transaction(async (tx) => ...)).
type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]

/**
 * #222: `User.pinnedCawCount` is a denormalised counter that two independent
 * confirm paths used to mutate with +1/-1 deltas:
 *   - api/routes/pins.ts            (off-chain / QuickSign confirm)
 *   - ActionProcessor/actionHandlers (on-chain indexer confirm)
 *
 * Each path is individually guarded, but under rapid pin/unpin/re-pin the
 * deltas race across paths and drift — the user-visible "4/3" cap display.
 * The `PinnedCaw` rows are the source of truth (`@@unique([userId, cawId])`
 * makes duplicates impossible), so derive the counter from them instead of
 * carrying arithmetic. Recompute is idempotent: it converges to the correct
 * value regardless of ordering or duplicate event replay, which also makes
 * any already-drifted row self-heal on the next pin/unpin for that user.
 *
 * Counts only effectively-pinned, visible rows, matching the read paths:
 *   - pending:true       → optimistic pin not confirmed yet (not shown)
 *   - pendingUnpin:true  → unpin in flight, suppressed from read paths
 *
 * MUST be called inside the same transaction as the row mutation, otherwise
 * a concurrent pin/unpin could recompute against a half-applied state.
 */
export async function recomputePinnedCount(tx: Tx, userId: number): Promise<void> {
  const n = await tx.pinnedCaw.count({
    where: { userId, pending: false, pendingUnpin: false },
  })
  await tx.user.update({
    where: { tokenId: userId },
    data: { pinnedCawCount: n },
  })
}

import { prisma } from '../prismaClient'
import { CAWONCE_HELD_TXQUEUE_STATUSES } from './txQueueStatus'

/**
 * The cawonces of rows that still hold theirs but have a NULL `cawonce` column,
 * read from the payload instead. The column is set for every row created now,
 * but a row from before the column existed (20260429100000 added it and
 * backfilled it) or on a schema made by `prisma db push` (which runs no data
 * migration, so it has no backfill) can have only the payload. Such a row is
 * normally old and final; one that is still in flight (an `underpriced` row can
 * stay for a long time) must still count, as it did when this read the payload.
 */
export async function legacyHeldCawonces(senderId: number): Promise<number[]> {
  const rows = await prisma.txQueue.findMany({
    where: { senderId, status: { in: [...CAWONCE_HELD_TXQUEUE_STATUSES] }, cawonce: null },
    select: { payload: true },
  })
  return rows
    .map(r => (r.payload as any)?.data?.cawonce)
    .filter((c): c is number => typeof c === 'number')
}

/**
 * The lowest cawonce a sender can use without colliding with something already
 * known to this node: one above the highest of
 *   - a pending scheduled post,
 *   - a TxQueue row whose cawonce may still land (see CAWONCE_HELD_TXQUEUE_STATUSES;
 *     for a row with no cawonce column, the payload's),
 *   - a confirmed Action.
 * The confirmed Action term covers gaps in the on-chain bitmap: the chain's
 * nextCawonce returns the first gap, which would reuse an already confirmed one.
 *
 * Returns null for `minSafeCawonce` when the sender has none of the three.
 */
export async function getMinSafeCawonce(tokenId: number): Promise<{
  minSafeCawonce: number | null
  hasScheduledPosts: boolean
}> {
  const [maxScheduled, maxQueued, legacy, maxConfirmed] = await Promise.all([
    prisma.scheduledCaw.aggregate({
      where: { userId: tokenId, status: 'pending', cawonce: { not: null } },
      _max: { cawonce: true },
    }),
    // The cawonce column is set by every path that creates a TxQueue row now.
    prisma.txQueue.aggregate({
      where: {
        senderId: tokenId,
        status: { in: [...CAWONCE_HELD_TXQUEUE_STATUSES] },
        cawonce: { not: null },
      },
      _max: { cawonce: true },
    }),
    legacyHeldCawonces(tokenId),
    prisma.action.aggregate({
      where: { senderId: tokenId },
      _max: { cawonce: true },
    }),
  ])

  const candidates = [
    maxScheduled._max.cawonce,
    maxQueued._max.cawonce,
    ...legacy,
    maxConfirmed._max.cawonce,
  ].filter((v): v is number => v !== null)

  return {
    minSafeCawonce: candidates.length > 0 ? Math.max(...candidates) + 1 : null,
    hasScheduledPosts: maxScheduled._max.cawonce !== null,
  }
}

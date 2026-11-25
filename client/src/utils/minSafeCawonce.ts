import { prisma } from '../prismaClient'
import { CAWONCE_HELD_TXQUEUE_STATUSES } from './txQueueStatus'

/**
 * The lowest cawonce a sender can use without colliding with something already
 * known to this node: one above the highest of
 *   - a pending scheduled post,
 *   - a TxQueue row whose cawonce may still land (see CAWONCE_HELD_TXQUEUE_STATUSES),
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
  const [maxScheduled, maxQueued, maxConfirmed] = await Promise.all([
    prisma.scheduledCaw.aggregate({
      where: { userId: tokenId, status: 'pending', cawonce: { not: null } },
      _max: { cawonce: true },
    }),
    // The cawonce column is set by every path that creates a TxQueue row.
    prisma.txQueue.aggregate({
      where: {
        senderId: tokenId,
        status: { in: [...CAWONCE_HELD_TXQUEUE_STATUSES] },
        cawonce: { not: null },
      },
      _max: { cawonce: true },
    }),
    prisma.action.aggregate({
      where: { senderId: tokenId },
      _max: { cawonce: true },
    }),
  ])

  const candidates = [
    maxScheduled._max.cawonce,
    maxQueued._max.cawonce,
    maxConfirmed._max.cawonce,
  ].filter((v): v is number => v !== null)

  return {
    minSafeCawonce: candidates.length > 0 ? Math.max(...candidates) + 1 : null,
    hasScheduledPosts: maxScheduled._max.cawonce !== null,
  }
}

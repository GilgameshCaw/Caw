import { prisma } from '../../prismaClient'

/**
 * Get IDs of users that the given user has blocked.
 * Used to filter content FROM blocked users out of the blocker's view.
 */
export async function getBlockedUserIds(userId: number): Promise<number[]> {
  const blocks = await prisma.block.findMany({
    where: { blockerId: userId },
    select: { blockedId: true }
  })
  return blocks.map(b => b.blockedId)
}

/**
 * Get IDs of users who have blocked the given user.
 * Used for DMs — if someone blocked you, you can't message them.
 */
export async function getBlockedByUserIds(userId: number): Promise<number[]> {
  const blocks = await prisma.block.findMany({
    where: { blockedId: userId },
    select: { blockerId: true }
  })
  return blocks.map(b => b.blockerId)
}

/**
 * Check if either user has blocked the other (bidirectional check for DMs).
 */
export async function isBlockedEitherDirection(userA: number, userB: number): Promise<boolean> {
  const block = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: userA, blockedId: userB },
        { blockerId: userB, blockedId: userA }
      ]
    }
  })
  return !!block
}

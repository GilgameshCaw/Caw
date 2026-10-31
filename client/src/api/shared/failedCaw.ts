import { PrismaClient, Prisma } from '@prisma/client'
import { countManager } from '../../services/CountManager'

class NoLongerFailed extends Error {}

/**
 * Which FAILED caws a new submission replaces: the same sender's, with the same
 * content, the same action type (reply/post vs. quote) and the same parent
 * (`originalCawId`; null for a standalone post), except the new caw itself.
 * The parent and the action type matter: matching on sender and content alone
 * also removes the sender's failed replies to other posts with identical text,
 * and gives back those posts' commentCount.
 */
export function replacedFailedCawsWhere(p: {
  userId: number
  content: string
  isRecaw: boolean
  originalCawId?: number | null
  excludeCawId: number
}): Prisma.CawWhereInput {
  return {
    userId: p.userId,
    content: p.content,
    action: p.isRecaw ? 'RECAW' : 'CAW',
    originalCawId: p.originalCawId || null,
    id: { not: p.excludeCawId },
  }
}

/** Delete the FAILED caws that a new submission replaces (retry cleanup). */
export function deleteReplacedFailedCaws(
  prisma: PrismaClient,
  p: Parameters<typeof replacedFailedCawsWhere>[0]
): Promise<number> {
  return deleteFailedCaws(prisma, replacedFailedCawsWhere(p))
}

/**
 * Delete the FAILED caws matching `where`, returning how many were deleted.
 *
 * A failed reply still has its pending Reply row (markTxQueueFailed marks the
 * Caw FAILED but leaves it) and the +1 that /api/actions put on the parent's
 * commentCount. Reply.replyCawId is a RESTRICT foreign key into Caw, so a
 * plain caw.deleteMany on such a row fails with P2003. Remove the Reply row
 * first and give back the commentCount it was holding.
 *
 * Each caw is handled in its own transaction. A caw can still leave FAILED
 * (the action lands on chain after all and is confirmed), so when the final
 * delete finds nothing, the transaction is rolled back and the Reply row and
 * the count are left as they were. The commentCount is only given back by the
 * call that actually deleted the Reply row, so two concurrent calls for the
 * same caw cannot decrement twice.
 */
export async function deleteFailedCaws(
  prisma: PrismaClient,
  where: Prisma.CawWhereInput
): Promise<number> {
  const failed = await prisma.caw.findMany({
    where: { ...where, status: 'FAILED' },
    select: { id: true },
  })

  let deleted = 0
  for (const { id } of failed) {
    try {
      await prisma.$transaction(async (tx) => {
        const replyRows = await tx.reply.findMany({
          where: { replyCawId: id },
          select: { id: true, cawId: true, pending: true },
        })
        for (const row of replyRows) {
          const removed = await tx.reply.deleteMany({ where: { id: row.id } })
          if (removed.count === 1 && row.pending) {
            await countManager.onStatusChanged(tx as any, 'reply', row.id, 'PENDING', 'FAILED', {
              cawId: row.cawId,
            })
          }
        }

        const result = await tx.caw.deleteMany({ where: { id, status: 'FAILED' } })
        if (result.count === 0) throw new NoLongerFailed()
      })
      deleted++
    } catch (err) {
      if (!(err instanceof NoLongerFailed)) throw err
    }
  }
  return deleted
}

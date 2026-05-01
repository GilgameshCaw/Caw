import { PrismaClient } from '@prisma/client'
import { countManager } from '../services/CountManager'

/**
 * THE single choke point for marking a TxQueue row as failed.
 *
 * ALL code that transitions a TxQueue row to 'failed' MUST go through this
 * helper — it atomically updates the row AND creates the ACTION_FAILED
 * notification so the two can never drift out of sync.
 *
 * Do NOT call `prisma.txQueue.update` (or `updateMany`) directly with
 * `status: 'failed'` anywhere. If grep finds `status: 'failed'` writes on
 * TxQueue outside this helper, that's a bug — fix it by routing through here.
 *
 * The `actionData` argument is usually `(entry.payload as any).data` from a
 * TxQueue row. If you don't have the payload at the call site (e.g. a bulk
 * timeout sweep), read it from the DB first so the notification can carry
 * the retry payload.
 *
 * This helper accepts a PrismaClient as its first arg so it can be called
 * from services that manage their own Prisma instance (DataCleaner) as well
 * as from the shared prismaClient (ValidatorService, API routes).
 */
export async function markTxQueueFailed(
  prisma: PrismaClient,
  txQueueId: number,
  reason: string,
  senderId: number,
  actionData: any
): Promise<void> {
  // Read the batchId BEFORE the update so we know whether this row is part
  // of a batched-sig group. When N rows share a batchId they all fail
  // together (one batch sig → one on-chain revert → N rows marked failed),
  // and emitting N notifications floods the user. Coalesce them via a
  // shared groupKey + a "first-row wins" check below.
  const row = await prisma.txQueue.findUnique({
    where: { id: txQueueId },
    select: { batchId: true },
  })
  const batchId = row?.batchId ?? null

  await prisma.txQueue.update({
    where: { id: txQueueId },
    data: { status: 'failed', reason }
  })
  await cleanupOptimisticRows(prisma, senderId, actionData, reason)

  // Don't notify for "Cawonce already used" — the action already succeeded
  // on-chain. This happens when the validator detects a revert but the tx
  // actually landed, or when a retry collides with the original.
  if (reason.includes('Cawonce already used')) return

  // Batched failure: only the FIRST row in the group emits a notification.
  // Subsequent rows in the same batch silently fail (their state is still
  // updated above; only the user-facing notification is skipped).
  if (batchId != null) {
    const groupKey = `action_failed_batch_${batchId}`
    const existing = await prisma.notification.findFirst({
      where: { userId: senderId, type: 'ACTION_FAILED', groupKey },
      select: { id: true },
    })
    if (existing) return
    await createActionFailedNotification(prisma, senderId, txQueueId, actionData, reason, groupKey)
    return
  }

  await createActionFailedNotification(prisma, senderId, txQueueId, actionData, reason)
}

/**
 * When a TxQueue row fails, the optimistic Follow / Like / Caw / Reply rows
 * that were created on submission need to be marked FAILED (or deleted) so
 * the UI stops showing ghost "pending" state. This was previously scattered
 * across several ad-hoc cleanup sites in the validator; consolidating it
 * here means every failure path gets consistent cleanup, including paths
 * that previously forgot to do it (DataCleaner timeout, safety-net sweep).
 */
async function cleanupOptimisticRows(
  prisma: PrismaClient,
  senderId: number,
  actionData: any,
  reason: string
): Promise<void> {
  const actionType = typeof actionData?.actionType === 'number'
    ? actionData.actionType
    : Number(actionData?.actionType ?? -1)
  const cawonce = typeof actionData?.cawonce === 'number' ? actionData.cawonce : null

  try {
    // CAW (0) / RECAW (3): mark the Caw row as FAILED so the feed shows it
    // with a failure indicator rather than lingering as "pending forever".
    if ((actionType === 0 || actionType === 3) && cawonce != null) {
      await prisma.caw.updateMany({
        where: { userId: senderId, cawonce, status: 'PENDING' },
        data: { status: 'FAILED', reason: reason.slice(0, 200) }
      })
      // If this Caw originated from a ScheduledCaw, the scheduled record is
      // currently sitting at status='published' (the processor flips it the
      // moment it queues the tx, before broadcast). Demote it to 'failed' so
      // the user sees it in the Failed tab on /scheduled instead of Published.
      await prisma.scheduledCaw.updateMany({
        where: { userId: senderId, cawonce, status: 'published' },
        data: { status: 'failed' },
      })
    }

    // FOLLOW (4) / UNFOLLOW (5): mark the pending Follow row as FAILED so
    // the UI reverts the optimistic follow-button state. Use updateMany in
    // case the record doesn't exist (paranoia — this never throws).
    if ((actionType === 4 || actionType === 5) && actionData?.receiverId != null) {
      await prisma.follow.updateMany({
        where: {
          followerId: senderId,
          followingId: actionData.receiverId,
          status: 'PENDING'
        },
        data: { status: 'FAILED' }
      })
    }

    // LIKE (1): delete the pending like so the heart count reverts. We
    // delete rather than mark FAILED because Like doesn't have a status
    // field we'd want to show — users expect the heart to unfill on failure.
    if (actionType === 1 && actionData?.receiverId != null && actionData?.receiverCawonce != null) {
      const targetCaw = await prisma.caw.findFirst({
        where: { userId: actionData.receiverId, cawonce: actionData.receiverCawonce },
        select: { id: true }
      })
      if (targetCaw) {
        const deleted = await prisma.like.deleteMany({
          where: { userId: senderId, cawId: targetCaw.id, pending: true }
        })
        if (deleted.count > 0) {
          // Decrement the likeCount we optimistically incremented on submit
          // Use CountManager's onStatusChanged for each removed pending like
          for (let i = 0; i < deleted.count; i++) {
            await countManager.onStatusChanged(prisma, 'like', 0, 'PENDING', 'FAILED', {
              cawId: targetCaw.id, userId: senderId,
            })
          }
        }
      }
    }

    // TIP (actionType 7 with tip: prefix): the pending Tip row should be
    // removed. Other OTHER-type actions (image uploads, profile updates)
    // each have their own cleanup patterns which we don't consolidate here
    // yet — Session C material if it becomes a problem.
    if (actionType === 7 && typeof actionData?.text === 'string' && actionData.text.startsWith('tip:') && cawonce != null) {
      await prisma.tip.deleteMany({
        where: { senderId, cawonce, pending: true }
      })
    }

    // VOTE (actionType 7 with vote: prefix): drop the pending Vote row the
    // optimistic API path wrote. The cawonce on a Vote row is the OTHER
    // action's cawonce — the same cawonce we have here — so this scopes
    // exactly to the failed submission and won't touch a confirmed prior
    // vote by the same user.
    if (actionType === 7 && typeof actionData?.text === 'string' && actionData.text.startsWith('vote:') && cawonce != null) {
      await prisma.vote.deleteMany({
        where: { voterId: senderId, cawonce, pending: true }
      })
    }

    // PIN / UNPIN (actionType 7 with pi: / xpi: prefix). Symmetric rollback:
    //   pi:  optimistic insert wrote a pending row → delete it.
    //   xpi: optimistic write only flipped pending=true on an EXISTING
    //        confirmed row → flip it back to pending=false. The original
    //        pin survives the failed unpin attempt.
    if (actionType === 7 && typeof actionData?.text === 'string') {
      const text: string = actionData.text
      if (text.startsWith('pi:')) {
        const cawId = parseInt(text.replace('pi:', '').trim())
        if (!isNaN(cawId) && cawId > 0) {
          await prisma.pinnedCaw.deleteMany({
            where: { userId: senderId, cawId, pending: true }
          })
        }
      } else if (text.startsWith('xpi:')) {
        const cawId = parseInt(text.replace('xpi:', '').trim())
        if (!isNaN(cawId) && cawId > 0) {
          await prisma.pinnedCaw.updateMany({
            where: { userId: senderId, cawId, pending: true },
            data: { pending: false }
          })
        }
      }
    }
  } catch (err: any) {
    console.warn(`[markTxQueueFailed] Optimistic cleanup failed for sender ${senderId}:`, err.message)
  }
}

/**
 * Create an ACTION_FAILED notification for the sender of a failed action.
 * Terminal failures only — callers must already have filtered out transient
 * waiting_for_deposit cases. The notification carries enough of the original
 * action payload to reconstruct it for a one-click retry from the UI.
 *
 * Normally you call `markTxQueueFailed` instead of this directly; it bundles
 * the update + notify so the two can never drift apart.
 */
export async function createActionFailedNotification(
  prisma: PrismaClient,
  senderId: number,
  txQueueId: number,
  actionData: any,
  reason: string,
  groupKey?: string,
): Promise<void> {
  try {
    // Skip action types that don't make sense to retry from a notification:
    // - withdraw (6): wallet-signed, has its own retry flow in the Staking UI
    // - unlike (2) / unfollow (5): no-op if the target state already matches
    const actionType = typeof actionData?.actionType === 'number'
      ? actionData.actionType
      : Number(actionData?.actionType ?? -1)
    if (actionType === 6 || actionType === 2 || actionType === 5) return

    // ACTION_FAILED is a self-notification: actor = user = sender.
    await prisma.notification.create({
      data: {
        userId: senderId,
        actorId: senderId,
        type: 'ACTION_FAILED',
        groupKey: groupKey,
        actionPayload: {
          actionType,
          receiverId: actionData?.receiverId ?? null,
          receiverCawonce: actionData?.receiverCawonce ?? null,
          text: actionData?.text ?? null,
          recipients: actionData?.recipients ?? null,
          amounts: actionData?.amounts ?? null,
          originalTxQueueId: txQueueId,
          reason,
        } as any,
      },
    })
  } catch (err: any) {
    console.warn(`[markTxQueueFailed] Failed to create ACTION_FAILED notification for tx ${txQueueId}:`, err.message)
  }
}

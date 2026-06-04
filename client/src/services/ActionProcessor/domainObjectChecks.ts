// src/services/ActionProcessor/domainObjectChecks.ts
import { findOrCreateUser } from '../UserService'
import { CawNotFoundError, findCawId } from './actionHandlers'
import type { PrismaTransactionClient, RawAction, ProcessedAction } from './types'

/**
 * Check if domain objects already exist for a given action
 * This is used when an action already exists in the database but we need to verify
 * if the corresponding domain objects (caw, like, follow) were created
 */
export async function checkDomainObjectExists(
  tx: PrismaTransactionClient,
  action: ProcessedAction,
  rawAction: RawAction,
  actionType: string
): Promise<boolean> {
  switch (actionType) {
    case 'CAW':
      return await checkCawExists(tx, action)

    case 'LIKE':
      return await checkLikeExists(tx, action, rawAction)

    case 'FOLLOW':
      return await checkFollowExists(tx, action, rawAction)

    case 'UNFOLLOW':
      // For unfollows, always process — we need to delete the follow record if it exists
      return false

    case 'UNLIKE':
      // For unlikes, always process — we need to remove the like
      return false

    case 'OTHER':
      return await checkOtherExists(tx, action, rawAction)

    default:
      // For unknown action types, assume domain object doesn't exist
      return false
  }
}

/**
 * Check if a caw already exists AND has been fully processed.
 *
 * "Fully processed" means any terminal status — SUCCESS, HIDDEN, or
 * FAILED — NOT just SUCCESS. Earlier this gated only on SUCCESS, which
 * caused a feedback loop: when a user hides their caw (status flips
 * SUCCESS → HIDDEN), the next ActionProcessor poll saw "not SUCCESS"
 * and treated the action as un-processed — re-running handleCawAction,
 * which clobbered HIDDEN back to SUCCESS in its upsert.update branch,
 * which the next handleHideAction flipped back to HIDDEN, and so on.
 * 59 mention-spam notifications fired across 59 minutes for a single
 * already-hidden caw before we noticed.
 *
 * PENDING is the only status that should re-enter — that's the
 * optimistic FE-side row waiting for chain confirmation.
 */
async function checkCawExists(
  tx: PrismaTransactionClient,
  action: ProcessedAction
): Promise<boolean> {
  const userId = await findOrCreateUser(action.senderId)
  const existingCaw = await tx.caw.findFirst({
    where: {
      userId: userId,
      cawonce: action.cawonce,
      action: 'CAW'
    }
  })
  if (!existingCaw) return false
  // Any terminal status counts as "already processed" — only PENDING
  // re-enters domain processing.
  return existingCaw.status !== 'PENDING'
}

/**
 * Check if a like already exists AND has been fully processed
 * Returns false for pending likes so ActionProcessor still handles them
 */
async function checkLikeExists(
  tx: PrismaTransactionClient,
  action: ProcessedAction,
  rawAction: RawAction
): Promise<boolean> {
  const userId = await findOrCreateUser(action.senderId)

  if (!rawAction.receiverId) {
    return false
  }

  // Only swallow the *expected* "parent caw not indexed locally" case here.
  // The outer Tx2 wrapper in index.ts already special-cases CawNotFoundError
  // (warns and skips), so returning false for that case is the equivalent
  // signal — domain row is uninteresting on this node, don't reprocess.
  // Any *other* throw (DB read failure, RPC blip via findOrCreateUser, etc.)
  // must bubble: the caller treats a thrown error as "unknown — retry on
  // next pass" instead of silently advancing past a stranded Action.
  try {
    const parentCawId = await findCawId(rawAction.receiverCawonce || 0, rawAction.receiverId)
    const existingLike = await tx.like.findUnique({
      where: { userId_cawId: { userId, cawId: parentCawId } }
    })
    // Only skip if like exists AND is not pending (fully processed)
    return existingLike ? !existingLike.pending : false
  } catch (err) {
    if (err instanceof CawNotFoundError) return false
    throw err
  }
}

/**
 * Check if a follow relationship already exists for the given action
 */
async function checkFollowExists(
  tx: PrismaTransactionClient,
  action: ProcessedAction,
  rawAction: RawAction
): Promise<boolean> {
  if (!rawAction.receiverId) {
    return false
  }

  const followerId = await findOrCreateUser(action.senderId)
  const followingId = await findOrCreateUser(rawAction.receiverId)

  const existingFollow = await tx.follow.findUnique({
    where: {
      followerId_followingId: { followerId, followingId }
    }
  })
  // Only skip if follow exists AND is already SUCCESS (fully processed)
  return existingFollow?.status === 'SUCCESS' && existingFollow?.action === 'FOLLOW'
}

/**
 * Check if an OTHER action's domain objects already exist
 * For tips: check if a confirmed tip exists for this sender+cawonce
 */
async function checkOtherExists(
  tx: PrismaTransactionClient,
  action: ProcessedAction,
  rawAction: RawAction
): Promise<boolean> {
  // hide:caw:{cawonce} — already processed if the target caw is HIDDEN.
  // Without this gate, every poll re-enters handleHideAction's
  // updateMany(status: HIDDEN where status: SUCCESS), gets count=0, logs
  // "No matching caw found", and we loop forever. Same feedback-loop class
  // as the SUCCESS→HIDDEN bug documented in checkCawExists above; the
  // CAW handler was fixed by checking any terminal status, but the
  // domain-object check for hide actions was never added. Reported by Zin
  // (167 MB log growth in hours).
  if (rawAction.text?.startsWith('hide:caw:')) {
    const targetCawonce = parseInt(rawAction.text.replace('hide:caw:', ''), 10)
    if (Number.isNaN(targetCawonce)) return false
    const senderId = await findOrCreateUser(action.senderId)
    const targetCaw = await tx.caw.findFirst({
      where: { userId: senderId, cawonce: targetCawonce },
      select: { status: true },
    })
    return targetCaw?.status === 'HIDDEN'
  }

  // hide:recaw:{receiverId}:{receiverCawonce} — already processed if the
  // sender's RECAW row for the original caw no longer exists. Mirrors the
  // handleHideAction lookup chain: receiver+receiverCawonce → originalCaw.id
  // → senderId+originalCawId RECAW row. If the row is gone, the undo-recaw
  // already ran and we should skip. Null target → return false: if the
  // original caw hasn't been indexed locally yet (mirror node case), let
  // the handler run (it's a no-op + warn). Same pattern as checkLikeExists.
  if (rawAction.text?.startsWith('hide:recaw:')) {
    const parts = rawAction.text.replace('hide:recaw:', '').split(':')
    const receiverTokenId = parseInt(parts[0], 10)
    const receiverCawonce = parseInt(parts[1], 10)
    if (Number.isNaN(receiverTokenId) || Number.isNaN(receiverCawonce)) return false
    const receiverUserId = await findOrCreateUser(receiverTokenId)
    const originalCaw = await tx.caw.findFirst({
      where: { userId: receiverUserId, cawonce: receiverCawonce },
      select: { id: true },
    })
    if (!originalCaw) return false  // not yet indexed locally; let handler run
    const senderUserId = await findOrCreateUser(action.senderId)
    const existingRecaw = await tx.caw.findFirst({
      where: { userId: senderUserId, originalCawId: originalCaw.id, action: 'RECAW' },
      select: { id: true },
    })
    return existingRecaw === null
  }

  // Only check for tip actions
  if (!rawAction.text?.startsWith('tip:')) {
    // For non-tip OTHER actions (profile updates etc), always reprocess
    return false
  }

  const senderId = await findOrCreateUser(action.senderId)
  const existingTip = await tx.tip.findFirst({
    where: {
      senderId,
      cawonce: action.cawonce
    }
  })
  // Only skip if tip exists AND is confirmed (not pending)
  return existingTip ? !existingTip.pending : false
}
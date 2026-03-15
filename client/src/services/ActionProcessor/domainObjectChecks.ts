// src/services/ActionProcessor/domainObjectChecks.ts
import { findOrCreateUser } from '../UserService'
import { findCawId } from './actionHandlers'
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

    case 'OTHER':
      return await checkOtherExists(tx, action, rawAction)

    default:
      // For unknown action types, assume domain object doesn't exist
      return false
  }
}

/**
 * Check if a caw already exists AND has been fully processed
 * Returns false for PENDING caws so ActionProcessor still handles them
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
  // Only skip if caw exists AND is already SUCCESS (fully processed)
  return existingCaw?.status === 'SUCCESS'
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

  try {
    const parentCawId = await findCawId(rawAction.receiverCawonce || 0, rawAction.receiverId)
    const existingLike = await tx.like.findUnique({
      where: { userId_cawId: { userId, cawId: parentCawId } }
    })
    // Only skip if like exists AND is not pending (fully processed)
    return existingLike ? !existingLike.pending : false
  } catch {
    // If we can't find the parent caw, assume like doesn't exist
    return false
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
  return !!existingFollow
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
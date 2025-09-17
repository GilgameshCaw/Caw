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

    default:
      // For unknown action types, assume domain object doesn't exist
      return false
  }
}

/**
 * Check if a caw already exists for the given action
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
  return !!existingCaw
}

/**
 * Check if a like already exists for the given action
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
    return !!existingLike
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
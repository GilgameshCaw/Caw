// src/services/ActionProcessor/domainProcessor.ts
import { findOrCreateUser } from '../UserService'
import {
  findCawId,
  handleCawAction,
  handleRecawAction,
  handleLikeAction,
  handleUnlikeAction,
  handleFollowAction,
  handleUnfollowAction,
  handleOtherAction,
  handleWithdrawAction
} from './actionHandlers'
import type { PrismaTransactionClient, RawAction, ProcessedAction } from './types'

/**
 * Process domain effects for a given action
 * This function delegates to specific handlers based on action type
 */
export async function processDomainEffects(
  tx: PrismaTransactionClient,
  action: ProcessedAction,
  rawAction: RawAction
): Promise<void> {
  console.log("TYPE", action.actionType)

  const authorId = await findOrCreateUser(action.senderId)

  // Determine parent caw for comment/reply actions
  let parentCawId: number | undefined
  if (rawAction.receiverId) {
    console.log("Searching for original caw id...", rawAction.receiverCawonce, rawAction.receiverId)
    try {
      parentCawId = await findCawId(
        rawAction.receiverCawonce || 0,
        rawAction.receiverId
      )
    } catch (err) {
      console.warn("Could not find parent caw:", err)
      // For some actions like FOLLOW, not finding a parent caw is acceptable
    }
  }

  // Delegate to specific handlers based on action type
  switch (action.actionType) {
    case 'CAW':
      await handleCawAction(tx, action, rawAction, authorId, parentCawId)
      break

    case 'RECAW':
      await handleRecawAction(tx, action, rawAction, parentCawId)
      break

    case 'LIKE':
      // For likes, we need to find the caw being liked
      if (!parentCawId && rawAction.receiverCawonce) {
        // The receiverId in a like might be 0, so we search by cawonce only
        const targetCaw = await tx.caw.findFirst({
          where: { cawonce: rawAction.receiverCawonce },
          orderBy: { createdAt: 'asc' }
        })
        parentCawId = targetCaw?.id
      }
      await handleLikeAction(tx, action, rawAction, parentCawId)
      break

    case 'UNLIKE':
      await handleUnlikeAction(tx, action, rawAction)
      break

    case 'FOLLOW':
      await handleFollowAction(tx, action, rawAction)
      break

    case 'UNFOLLOW':
      await handleUnfollowAction(tx, action, rawAction)
      break

    case 'OTHER':
      await handleOtherAction(tx, action, rawAction, authorId, parentCawId)
      break

    case 'WITHDRAW':
      await handleWithdrawAction(tx, action, rawAction)
      break

    default:
      console.warn(`Unknown action type: ${action.actionType}`)
      // For unknown action types, we can choose to either skip or throw
      break
  }
}
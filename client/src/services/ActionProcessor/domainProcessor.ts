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
import type { PrismaTransactionClient, RawAction } from './types'

export interface ResolvedUsers {
  authorId: number
  receiverId?: number
}

/**
 * Resolve sender (and, when relevant, receiver) users BEFORE the interactive
 * transaction opens. Prevents `findOrCreateUser` from eating into the 5s tx
 * timeout when a batch of same-sender actions arrives in parallel.
 */
export async function resolveActionUsers(rawAction: RawAction): Promise<ResolvedUsers> {
  const authorId = await findOrCreateUser(rawAction.senderId)
  let receiverId: number | undefined
  // FOLLOW(4) / UNFOLLOW(5) both sides are users; LIKE/RECAW target a caw,
  // not a user, so the receiverId there is a cawonce, not a token.
  const type = Number(rawAction.actionType)
  if ((type === 4 || type === 5) && rawAction.receiverId) {
    receiverId = await findOrCreateUser(rawAction.receiverId)
  }
  return { authorId, receiverId }
}

/**
 * Process domain effects for a given action
 * This function delegates to specific handlers based on action type
 */
export async function processDomainEffects(
  tx: PrismaTransactionClient,
  action: any,
  rawAction: RawAction,
  resolved: ResolvedUsers
): Promise<void> {
  const { authorId } = resolved

  // Determine parent caw for comment/reply actions
  let parentCawId: number | undefined
  if (rawAction.receiverId) {
    try {
      parentCawId = await findCawId(
        rawAction.receiverCawonce || 0,
        rawAction.receiverId
      )
    } catch (err) {
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
      break
  }
}
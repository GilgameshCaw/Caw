// src/services/ActionProcessor/domainProcessor.ts
import { findOrCreateUser } from '../UserService'
import getActionType from '../../abi/getActionType'
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
  // rawAction.actionType is the raw enum *number* from the unpacked on-chain
  // event (see packActions.ts). Convert once to the Prisma string form so
  // comparisons here match the 'CAW'/'FOLLOW'/... switch in processDomainEffects
  // just below — keeps the two sibling functions working off the same vocabulary.
  const type = getActionType(Number(rawAction.actionType))
  // For FOLLOW/UNFOLLOW, receiverId is the followed user's tokenId — pre-resolve
  // it so the handler's findOrCreateUser(receiverId) call inside the tx is a
  // cache hit. For LIKE/RECAW, receiverId is the caw *owner*'s tokenId; we
  // don't pre-resolve that because findCawId handles it inside the tx.
  if ((type === 'FOLLOW' || type === 'UNFOLLOW') && rawAction.receiverId) {
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
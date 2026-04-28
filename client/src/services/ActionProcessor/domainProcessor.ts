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
 * Resolve every user that the inside-tx code path might need BEFORE the
 * interactive transaction opens. Prevents findOrCreateUser from eating
 * into the 5s tx timeout — every inside-tx call must hit the user cache.
 *
 * Critical hazard this defends against: findCawId (called from
 * processDomainEffects inside the tx) calls findOrCreateUser on the caw
 * owner. If that caw owner is a brand-new user, the call falls back to
 * an L1 RPC read with a 15s timeout — well past the 5s tx budget. The
 * tx times out, every queued query inside it errors with "Transaction
 * already closed", and the row partial-state is left behind.
 *
 * We pre-resolve:
 *   - sender (always)
 *   - receiverId, if present (covers FOLLOW/UNFOLLOW target, LIKE/RECAW
 *     caw owner via findCawId, and any future receiver-flavored field)
 *   - tip recipients (rawAction.recipients[0]) — handleTipAction calls
 *     findOrCreateUser on it inside the tx
 *
 * Worst case: one extra cache entry for a tokenId that wasn't strictly
 * required. Best case (the common case): the inside-tx code path never
 * makes an L1 RPC call.
 */
export async function resolveActionUsers(rawAction: RawAction): Promise<ResolvedUsers> {
  // Pre-resolve in parallel — single L1 round-trip latency for the whole
  // set instead of serial. findOrCreateUser is idempotent + cached, so
  // duplicates (sender == receiver) just hit the cache.
  const senderPromise = findOrCreateUser(rawAction.senderId)
  const receiverPromise = rawAction.receiverId
    ? findOrCreateUser(rawAction.receiverId)
    : Promise.resolve(undefined)
  // rawAction.actionType is the raw enum *number* from the unpacked
  // on-chain event (see packActions.ts). Convert once for tip-recipient
  // pre-resolution.
  const type = getActionType(Number(rawAction.actionType))
  const recipientPromise = (type === 'OTHER' && rawAction.recipients?.[0])
    ? findOrCreateUser(Number(rawAction.recipients[0]))
    : Promise.resolve(undefined)

  const [authorId, receiverId] = await Promise.all([
    senderPromise,
    receiverPromise,
    recipientPromise,
  ])
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
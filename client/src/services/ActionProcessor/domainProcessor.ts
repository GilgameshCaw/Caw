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
import { getNetworkId } from '../../utils/networkId'

export interface ResolvedUsers {
  authorId: number
  receiverId?: number
}

// Our scoped clientId. Resolved once at module load — config never changes
// at runtime. RawEvent ingest persists every client's actions (multiplier
// is global, cross-client likes/follows/tips on caws we already have need
// to land too), but new content (CAW + RECAW = new Caw rows) is gated to
// our client so the local feed stays scoped.
const OUR_CLIENT_ID = (() => {
  const raw = getNetworkId()
  const n = raw === undefined || raw === null ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
})()

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

  // Cross-client gate: CAW + RECAW create new content rows in our DB,
  // and we want our local feed to only contain content posted via THIS
  // client. Other action types (likes, follows, tips, etc.) operate on
  // existing targets and need to land regardless of submitting client —
  // a like from a user authed to both clients should bump our like-count
  // either way; if the target isn't ours, the natural CawNotFoundError
  // path skips quietly.
  const isOurClient = OUR_CLIENT_ID === null || Number(rawAction.networkId) === OUR_CLIENT_ID

  // Delegate to specific handlers based on action type
  switch (action.actionType) {
    case 'CAW':
      if (!isOurClient) return
      await handleCawAction(tx, action, rawAction, authorId, parentCawId)
      break

    case 'RECAW':
      if (!isOurClient) return
      await handleRecawAction(tx, action, rawAction, parentCawId)
      break

    case 'LIKE':
      // For likes, we need to find the caw being liked. cawonce is
      // per-user, so a search by cawonce alone resolved to the
      // chronologically-OLDEST caw with that cawonce (typically a
      // low-userId user's first post) — completely wrong attribution.
      // Audit fix 2026-05-09 (Round 5 backend HIGH-2): drop the fallback.
      // A LIKE without a valid (receiverId, receiverCawonce) is malformed
      // and should be skipped at the handler layer.
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
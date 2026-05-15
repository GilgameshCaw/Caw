/**
 * CountManager — the SINGLE source of truth for incrementing/decrementing
 * counts on Caw records (commentCount, recawCount, likeCount) and User
 * records (cawCount, recawCount, followerCount, followingCount, likeCount).
 *
 * PROBLEM: 27+ places across the codebase increment/decrement counts,
 * leading to double-counting when:
 *   1. The API batch endpoint creates optimistic pending records and increments counts
 *   2. The ActionProcessor processes confirmed on-chain events and increments again
 *   3. Failed actions retry, creating new pending records and incrementing again
 *
 * SOLUTION: All count mutations flow through this single service, which
 * enforces consistent rules about WHEN counts should change:
 *   - Optimistic: increment when pending record is created
 *   - Confirmation: NO-OP (already counted)
 *   - Failure: decrement (undo the optimistic increment)
 *
 * Every count change is logged with a reason tag for debugging.
 *
 * Usage:
 *   import { countManager } from '../services/CountManager'
 *
 *   await prisma.$transaction(async (tx) => {
 *     const caw = await tx.caw.create({ ... })
 *     await countManager.onCawCreated(tx, { id: caw.id, userId, action: 'CAW', originalCawId: null, status: 'PENDING' })
 *   })
 */

import { PrismaClient, Prisma } from '@prisma/client'

type TxClient = Prisma.TransactionClient | PrismaClient

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TAG = '[CountManager]'

function log(message: string): void {
  console.log(`${TAG} ${message}`)
}

function warn(message: string): void {
  console.warn(`${TAG} ${message}`)
}

/**
 * Atomically decrement a column but never below zero.
 * Uses raw SQL with GREATEST to prevent negative counts.
 */
async function safeDecrement(
  tx: TxClient,
  table: 'Caw' | 'User',
  column: string,
  idColumn: string,
  idValue: number,
  amount: number = 1
): Promise<void> {
  // Prisma's $executeRaw is available on both PrismaClient and TransactionClient
  await (tx as any).$executeRawUnsafe(
    `UPDATE "${table}" SET "${column}" = GREATEST(0, "${column}" - $1) WHERE "${idColumn}" = $2`,
    amount,
    idValue
  )
}

/**
 * Atomically increment a column using Prisma's built-in atomic operation.
 */
async function safeIncrement(
  tx: TxClient,
  table: 'Caw' | 'User',
  idColumn: string,
  idValue: number,
  column: string,
  amount: number = 1
): Promise<void> {
  if (table === 'Caw') {
    await (tx as any).caw.update({
      where: { id: idValue },
      data: { [column]: { increment: amount } }
    })
  } else {
    await (tx as any).user.update({
      where: { [idColumn]: idValue },
      data: { [column]: { increment: amount } }
    })
  }
}

// ---------------------------------------------------------------------------
// CountManager
// ---------------------------------------------------------------------------

const countManager = {

  // =========================================================================
  // onCawCreated
  // Called when a new pending Caw record is created (post, reply, recaw).
  // Only increments counts when the caw is in PENDING status — confirmed
  // caws that arrive directly from the ActionProcessor (no prior pending
  // record) also pass through here with status=SUCCESS.
  // =========================================================================
  async onCawCreated(
    tx: TxClient,
    caw: {
      id: number
      userId: number
      action: string
      originalCawId: number | null
      status: string
    }
  ): Promise<void> {
    if (caw.status !== 'PENDING' && caw.status !== 'SUCCESS') {
      warn(`onCawCreated called with unexpected status="${caw.status}" for caw ${caw.id} — skipping`)
      return
    }

    const label = caw.status === 'PENDING' ? 'optimistic' : 'confirmed-new'

    // Determine if this is a plain recaw (no text — just a repost) vs a quote/caw
    const isPlainRecaw = caw.action === 'RECAW'

    if (isPlainRecaw) {
      // Plain recaws increment user.recawCount
      await safeIncrement(tx, 'User', 'tokenId', caw.userId, 'recawCount')
      log(`recawCount +1 on user ${caw.userId} (${label} recaw created, caw ${caw.id})`)
    } else {
      // CAW posts and quotes increment user.cawCount
      await safeIncrement(tx, 'User', 'tokenId', caw.userId, 'cawCount')
      log(`cawCount +1 on user ${caw.userId} (${label} caw created, caw ${caw.id})`)
    }

    // If this is a RECAW with an originalCawId, increment the parent's recawCount
    if (caw.action === 'RECAW' && caw.originalCawId) {
      await safeIncrement(tx, 'Caw', 'id', caw.originalCawId, 'recawCount')
      log(`recawCount +1 on caw ${caw.originalCawId} (${label} recaw ${caw.id})`)
    }

    // If this is a quote (CAW with originalCawId), increment the parent's recawCount
    // Quotes are CAW-type actions that reference an original caw
    if (caw.action === 'CAW' && caw.originalCawId) {
      await safeIncrement(tx, 'Caw', 'id', caw.originalCawId, 'recawCount')
      log(`recawCount +1 on caw ${caw.originalCawId} (${label} quote ${caw.id})`)
    }
  },

  // =========================================================================
  // onReplyCreated
  // Called when a pending Reply record is created, linking a reply caw to its
  // parent. Increments commentCount on the parent caw.
  // =========================================================================
  async onReplyCreated(
    tx: TxClient,
    reply: {
      cawId: number
      replyCawId: number
      pending: boolean
    }
  ): Promise<void> {
    await safeIncrement(tx, 'Caw', 'id', reply.cawId, 'commentCount')
    log(`commentCount +1 on caw ${reply.cawId} (reply ${reply.replyCawId} created, pending=${reply.pending})`)
  },

  // =========================================================================
  // onLikeCreated
  // Called when a pending Like record is created. Increments:
  //   - Caw.likeCount on the target caw (popularity)
  //   - User.likedCount on the liker (likes given by them)
  //   - User.likesReceivedCount on the caw owner (likes received on their content)
  // =========================================================================
  async onLikeCreated(
    tx: TxClient,
    like: {
      cawId: number
      userId: number
      pending: boolean
    }
  ): Promise<void> {
    await safeIncrement(tx, 'Caw', 'id', like.cawId, 'likeCount')
    log(`likeCount +1 on caw ${like.cawId} (like by user ${like.userId}, pending=${like.pending})`)

    // The two User-row increments (liker.likedCount + recipient.likesReceivedCount)
    // touch different rows but the same table — concurrent likes between two users
    // can deadlock if A→B is acquired in (liker, recipient) order while B→A is
    // acquired in the opposite order. Sort by tokenId so every worker takes the
    // same lock order regardless of which side they're processing.
    const caw = await (tx as any).caw.findUnique({ where: { id: like.cawId }, select: { userId: true } })
    const recipientId: number | null = caw?.userId ?? null
    const userBumps: Array<{ id: number; column: 'likedCount' | 'likesReceivedCount'; reason: string }> = [
      { id: like.userId, column: 'likedCount', reason: `liked caw ${like.cawId}` },
    ]
    if (recipientId !== null) {
      userBumps.push({ id: recipientId, column: 'likesReceivedCount', reason: `caw ${like.cawId} liked by user ${like.userId}` })
    } else {
      warn(`onLikeCreated: caw ${like.cawId} not found, skipping likesReceivedCount`)
    }
    userBumps.sort((a, b) => a.id - b.id)
    for (const b of userBumps) {
      await safeIncrement(tx, 'User', 'tokenId', b.id, b.column)
      log(`${b.column} +1 on user ${b.id} (${b.reason})`)
    }
  },

  // =========================================================================
  // onFollowCreated
  // Called when a Follow record is created (pending or confirmed).
  // Increments followingCount on the follower and followerCount on the target.
  // =========================================================================
  async onFollowCreated(
    tx: TxClient,
    follow: {
      followerId: number
      followingId: number
    }
  ): Promise<void> {
    // Sort the two row-lock targets by tokenId so concurrent follows in the
    // opposite direction (A→B and B→A) don't deadlock. Both transactions
    // will acquire the smaller-id row first, then the larger-id row.
    const ops: Array<{ id: number; column: 'followingCount' | 'followerCount'; reason: string }> = [
      { id: follow.followerId, column: 'followingCount', reason: `now follows user ${follow.followingId}` },
      { id: follow.followingId, column: 'followerCount', reason: `new follower: user ${follow.followerId}` },
    ]
    ops.sort((a, b) => a.id - b.id)
    for (const op of ops) {
      await safeIncrement(tx, 'User', 'tokenId', op.id, op.column)
      log(`${op.column} +1 on user ${op.id} (${op.reason})`)
    }
  },

  // =========================================================================
  // onStatusChanged
  // Called when any entity transitions between statuses.
  //
  // Rules:
  //   PENDING -> SUCCESS : NO-OP (counts were already set optimistically)
  //   PENDING -> FAILED  : DECREMENT (undo the optimistic increment)
  //   SUCCESS -> PENDING : DECREMENT (optimistic-undo, e.g. unlike/unfollow
  //                                   in flight — counts come off now, will
  //                                   come back via PENDING -> SUCCESS-undo
  //                                   if the tx fails)
  //   FAILED  -> SUCCESS : NO-OP here. Chain confirmed a caw that
  //                        DataCleaner had previously swept to FAILED.
  //                        Restoring counts that DataCleaner rolled back
  //                        (parent.recawCount for RECAW) is done at the
  //                        handler callsite — see handleRecawAction's
  //                        FAILED→SUCCESS branch — because it requires a
  //                        live COUNT(*) recompute that mirrors what
  //                        DataCleaner does in reverse, and is action-
  //                        type-specific in a way the generic transition
  //                        rule can't express.
  //   All other transitions: log a warning
  //
  // The `meta` parameter carries entity-specific context needed to know
  // WHICH counts to decrement. Shape depends on entity:
  //   entity='caw':    meta = { userId, action, originalCawId }
  //   entity='reply':  meta = { cawId, replyCawId }
  //   entity='like':   meta = { cawId, userId }
  //   entity='follow': meta = { followerId, followingId }
  // =========================================================================
  async onStatusChanged(
    tx: TxClient,
    entity: string,
    id: number,
    oldStatus: string,
    newStatus: string,
    meta?: any
  ): Promise<void> {
    // PENDING -> SUCCESS: no count change needed
    if (oldStatus === 'PENDING' && newStatus === 'SUCCESS') {
      log(`${entity} ${id}: PENDING -> SUCCESS (no-op, counts already set)`)
      return
    }

    // FAILED -> SUCCESS: chain confirmed an entity that DataCleaner had
    // previously swept to FAILED. Restoration of any rolled-back counts
    // (specifically parent.recawCount for plain RECAW; userCawCount is
    // not touched by DataCleaner) is done at the handler callsite via a
    // direct COUNT(*) recompute. From CountManager's perspective this
    // is a logged no-op — keeping the call here means every status
    // transition flows through one place for log consistency.
    if (oldStatus === 'FAILED' && newStatus === 'SUCCESS') {
      log(`${entity} ${id}: FAILED -> SUCCESS (chain confirmation; count restoration handled at callsite)`)
      return
    }

    // SUCCESS -> PENDING: optimistic undo (used for in-flight unlike /
    // unfollow). The user previously had a confirmed Like/Follow row; we
    // flip it to pending-undo and decrement the cached counters now so the
    // UI reflects the undo immediately. If the tx fails, the matching
    // PENDING -> SUCCESS-undo restore path will increment them back.
    if (oldStatus === 'SUCCESS' && newStatus === 'PENDING') {
      log(`${entity} ${id}: SUCCESS -> PENDING — applying optimistic-undo decrement`)

      switch (entity) {
        case 'like': {
          if (!meta) { warn(`onStatusChanged like ${id}: missing meta for optimistic-undo`); return }
          const { cawId: likeCawId, userId: likeUserId } = meta

          await safeDecrement(tx, 'Caw', 'likeCount', 'id', likeCawId)
          log(`likeCount -1 on caw ${likeCawId} (pending unlike ${id})`)

          // Sort the two User-row lock targets so concurrent unlikes between
          // two users acquire the smaller-id row first (deadlock avoidance).
          const undoCaw = await (tx as any).caw.findUnique({ where: { id: likeCawId }, select: { userId: true } })
          const userDecs: Array<{ id: number; column: 'likedCount' | 'likesReceivedCount'; reason: string }> = [
            { id: likeUserId, column: 'likedCount', reason: `pending unlike ${id}` },
          ]
          if (undoCaw) {
            userDecs.push({ id: undoCaw.userId, column: 'likesReceivedCount', reason: `pending unlike on caw ${likeCawId}` })
          }
          userDecs.sort((a, b) => a.id - b.id)
          for (const d of userDecs) {
            await safeDecrement(tx, 'User', d.column, 'tokenId', d.id)
            log(`${d.column} -1 on user ${d.id} (${d.reason})`)
          }
          break
        }

        case 'follow': {
          if (!meta) { warn(`onStatusChanged follow ${id}: missing meta for optimistic-undo`); return }
          const { followerId, followingId } = meta

          // Sort by id so A→B unfollow and B→A unfollow can't deadlock.
          const decs: Array<{ id: number; column: 'followingCount' | 'followerCount'; reason: string }> = [
            { id: followerId, column: 'followingCount', reason: `pending unfollow ${id}` },
            { id: followingId, column: 'followerCount', reason: `pending unfollow ${id}` },
          ]
          decs.sort((a, b) => a.id - b.id)
          for (const d of decs) {
            await safeDecrement(tx, 'User', d.column, 'tokenId', d.id)
            log(`${d.column} -1 on user ${d.id} (${d.reason})`)
          }
          break
        }

        default:
          warn(`onStatusChanged: SUCCESS->PENDING not supported for entity "${entity}" id ${id}`)
      }
      return
    }

    // PENDING -> SUCCESS-undo (restore): "undo the undo" when an in-flight
    // unlike / unfollow tx fails. The original SUCCESS -> PENDING decremented
    // optimistically; this restores +1 on each touched counter.
    if (oldStatus === 'PENDING' && newStatus === 'SUCCESS-undo') {
      log(`${entity} ${id}: PENDING -> SUCCESS-undo — restoring counts after failed undo`)

      switch (entity) {
        case 'like': {
          if (!meta) { warn(`onStatusChanged like ${id}: missing meta for restore`); return }
          const { cawId: likeCawId, userId: likeUserId } = meta

          await safeIncrement(tx, 'Caw', 'id', likeCawId, 'likeCount')
          log(`likeCount +1 on caw ${likeCawId} (unlike ${id} failed)`)

          // Sort by id (deadlock avoidance — see SUCCESS→PENDING branch above).
          const restoredCaw = await (tx as any).caw.findUnique({ where: { id: likeCawId }, select: { userId: true } })
          const userIncs: Array<{ id: number; column: 'likedCount' | 'likesReceivedCount'; reason: string }> = [
            { id: likeUserId, column: 'likedCount', reason: `unlike ${id} failed` },
          ]
          if (restoredCaw) {
            userIncs.push({ id: restoredCaw.userId, column: 'likesReceivedCount', reason: `unlike ${id} on caw ${likeCawId} failed` })
          }
          userIncs.sort((a, b) => a.id - b.id)
          for (const u of userIncs) {
            await safeIncrement(tx, 'User', 'tokenId', u.id, u.column)
            log(`${u.column} +1 on user ${u.id} (${u.reason})`)
          }
          break
        }

        case 'follow': {
          if (!meta) { warn(`onStatusChanged follow ${id}: missing meta for restore`); return }
          const { followerId, followingId } = meta

          // Sort by id so concurrent failed-undo restores can't deadlock.
          const incs: Array<{ id: number; column: 'followingCount' | 'followerCount'; reason: string }> = [
            { id: followerId, column: 'followingCount', reason: `unfollow ${id} failed` },
            { id: followingId, column: 'followerCount', reason: `unfollow ${id} failed` },
          ]
          incs.sort((a, b) => a.id - b.id)
          for (const i of incs) {
            await safeIncrement(tx, 'User', 'tokenId', i.id, i.column)
            log(`${i.column} +1 on user ${i.id} (${i.reason})`)
          }
          break
        }

        default:
          warn(`onStatusChanged: PENDING->SUCCESS-undo not supported for entity "${entity}" id ${id}`)
      }
      return
    }

    // PENDING -> FAILED: undo optimistic counts
    if (oldStatus === 'PENDING' && newStatus === 'FAILED') {
      log(`${entity} ${id}: PENDING -> FAILED — rolling back counts`)

      switch (entity) {
        case 'caw': {
          if (!meta) { warn(`onStatusChanged caw ${id}: missing meta for rollback`); return }
          const { userId, action, originalCawId } = meta

          // Undo user count increment
          if (action === 'RECAW') {
            await safeDecrement(tx, 'User', 'recawCount', 'tokenId', userId)
            log(`recawCount -1 on user ${userId} (caw ${id} failed)`)
          } else {
            await safeDecrement(tx, 'User', 'cawCount', 'tokenId', userId)
            log(`cawCount -1 on user ${userId} (caw ${id} failed)`)
          }

          // Undo parent recawCount if applicable
          if (originalCawId && (action === 'RECAW' || action === 'CAW')) {
            await safeDecrement(tx, 'Caw', 'recawCount', 'id', originalCawId)
            log(`recawCount -1 on caw ${originalCawId} (child ${id} failed)`)
          }
          break
        }

        case 'reply': {
          if (!meta) { warn(`onStatusChanged reply ${id}: missing meta for rollback`); return }
          const { cawId } = meta

          await safeDecrement(tx, 'Caw', 'commentCount', 'id', cawId)
          log(`commentCount -1 on caw ${cawId} (reply ${id} failed)`)
          break
        }

        case 'like': {
          if (!meta) { warn(`onStatusChanged like ${id}: missing meta for rollback`); return }
          const { cawId: likeCawId, userId: likeUserId } = meta

          await safeDecrement(tx, 'Caw', 'likeCount', 'id', likeCawId)
          log(`likeCount -1 on caw ${likeCawId} (like ${id} failed)`)

          await safeDecrement(tx, 'User', 'likedCount', 'tokenId', likeUserId)
          log(`likedCount -1 on user ${likeUserId} (like ${id} failed)`)

          // Roll back the caw owner's likesReceivedCount that we bumped on create.
          const failedCaw = await (tx as any).caw.findUnique({ where: { id: likeCawId }, select: { userId: true } })
          if (failedCaw) {
            await safeDecrement(tx, 'User', 'likesReceivedCount', 'tokenId', failedCaw.userId)
            log(`likesReceivedCount -1 on user ${failedCaw.userId} (like ${id} on caw ${likeCawId} failed)`)
          }
          break
        }

        case 'follow': {
          if (!meta) { warn(`onStatusChanged follow ${id}: missing meta for rollback`); return }
          const { followerId, followingId } = meta

          await safeDecrement(tx, 'User', 'followingCount', 'tokenId', followerId)
          log(`followingCount -1 on user ${followerId} (follow ${id} failed)`)

          await safeDecrement(tx, 'User', 'followerCount', 'tokenId', followingId)
          log(`followerCount -1 on user ${followingId} (follow ${id} failed)`)
          break
        }

        default:
          warn(`onStatusChanged: unknown entity "${entity}" for id ${id}`)
      }
      return
    }

    // Unexpected transition
    warn(`${entity} ${id}: unexpected transition ${oldStatus} -> ${newStatus} — no count change`)
  },

  // =========================================================================
  // onLikeRemoved
  // Called when a like is deleted (unlike action). Decrements:
  //   - Caw.likeCount on the target caw
  //   - User.likedCount on the unliker (likes given by them)
  //   - User.likesReceivedCount on the caw owner (likes received on their content)
  // =========================================================================
  async onLikeRemoved(
    tx: TxClient,
    like: {
      cawId: number
      userId: number
    }
  ): Promise<void> {
    await safeDecrement(tx, 'Caw', 'likeCount', 'id', like.cawId)
    log(`likeCount -1 on caw ${like.cawId} (unlike by user ${like.userId})`)

    await safeDecrement(tx, 'User', 'likedCount', 'tokenId', like.userId)
    log(`likedCount -1 on user ${like.userId} (unliked caw ${like.cawId})`)

    // Roll back the caw owner's likesReceivedCount that we bumped on the original like.
    const caw = await (tx as any).caw.findUnique({ where: { id: like.cawId }, select: { userId: true } })
    if (caw) {
      await safeDecrement(tx, 'User', 'likesReceivedCount', 'tokenId', caw.userId)
      log(`likesReceivedCount -1 on user ${caw.userId} (caw ${like.cawId} unliked by user ${like.userId})`)
    }
  },

  // =========================================================================
  // onFollowRemoved
  // Called when a follow is deleted (unfollow action). Decrements
  // followingCount on the follower and followerCount on the target.
  // =========================================================================
  async onFollowRemoved(
    tx: TxClient,
    follow: {
      followerId: number
      followingId: number
    }
  ): Promise<void> {
    await safeDecrement(tx, 'User', 'followingCount', 'tokenId', follow.followerId)
    log(`followingCount -1 on user ${follow.followerId} (unfollowed user ${follow.followingId})`)

    await safeDecrement(tx, 'User', 'followerCount', 'tokenId', follow.followingId)
    log(`followerCount -1 on user ${follow.followingId} (lost follower: user ${follow.followerId})`)
  },
}

export { countManager }
export default countManager

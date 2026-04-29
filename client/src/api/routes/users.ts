// src/api/routes/users.ts
import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { ActionType } from '@prisma/client'
// Tier 1 + Tier 2 of the "RPC out of API request handlers" refactor:
// - findOrCreateUser is NOT imported. API endpoints read only from the DB;
//   on a miss we return 202 and let the indexer (RawEventsGatherer +
//   NftTransferWatcher) populate the row asynchronously. The frontend
//   retries with backoff until the row appears.
// - The L2 cawBalanceOf read used to live here as `readOnChainStake`,
//   throttled per-token to 15s. It's now cached on User.onChainStakeWei
//   by DataCleaner's `refreshOnChainStakeForPendingDeposits` pass and read
//   straight from the DB. The Contract/provider plumbing is gone.
import { getBlockedUserIds } from '../shared/blockUtils'
import { requireAuth } from '../middleware/auth'

// Validation limits for profile fields (must match ActionProcessor)
const PROFILE_FIELD_LIMITS: Record<string, number> = {
  displayName: 50,
  bio: 500,
  location: 100,
  website: 200,
  avatarUrl: 500,
  coverPhotoUrl: 500,
}

const router = Router()

/**
 * POST /api/users/ensure
 * Look up a user record by tokenId.
 *
 * Tier 1 of the "RPC out of API request handlers" refactor: this endpoint
 * no longer falls back to L1/L2 RPC reads on a DB miss. RawEventsGatherer
 * (Mint event listener) and NftTransferWatcher populate the User row
 * asynchronously — the frontend retries with backoff until that lands.
 *
 * - 200 + { user } when present in DB
 * - 202 + { error: 'user not yet indexed', retryAfterSeconds } when absent
 *
 * No auth required (called during onboarding before session is established).
 * IMPORTANT: This route must be defined BEFORE /:username to avoid conflicts.
 */
router.post('/ensure', async (req, res) => {
  const startTime = Date.now()
  try {
    const { tokenId } = req.body
    console.log(`[/api/users/ensure] START tokenId=${tokenId}`)

    if (!tokenId || isNaN(Number(tokenId))) {
      return res.status(400).json({ error: 'tokenId is required' })
    }

    const numericTokenId = Number(tokenId)
    const user = await prisma.user.findUnique({
      where: { tokenId: numericTokenId },
      select: { tokenId: true, username: true, address: true }
    })
    const totalDuration = Date.now() - startTime

    if (!user) {
      console.log(`[/api/users/ensure] tokenId=${numericTokenId} not yet indexed (${totalDuration}ms)`)
      res.setHeader('Retry-After', '3')
      return res.status(202).json({
        error: 'user not yet indexed',
        retryAfterSeconds: 3,
      })
    }

    console.log(`[/api/users/ensure] SUCCESS in ${totalDuration}ms, user=${JSON.stringify(user)}`)
    return res.json({ user })
  } catch (error: any) {
    const totalDuration = Date.now() - startTime
    console.error(`[/api/users/ensure] ERROR after ${totalDuration}ms:`, error.message)
    console.error('Stack trace:', error.stack)
    return res.status(500).json({ error: error.message || 'Failed to ensure user' })
  }
})

/**
 * GET /api/users/badges?userId=N
 * Returns all unread/unseen badge counts for a user in a single round-trip:
 * - notifications: number of unread notifications
 * - dmConversations: array of conversation ids + unreadCount (for muting filter on the client)
 * - offers: number of unseen marketplace offers received
 *
 * Frontend uses this to combine three previously-separate polls into one.
 * IMPORTANT: This route must be defined BEFORE /:username to avoid conflicts.
 */
router.get('/badges', requireAuth({ lookup: async (req) => Number(req.query.userId) || undefined }), async (req, res) => {
  try {
    const userId = parseInt(req.query.userId as string)
    if (!userId || isNaN(userId)) {
      return res.status(400).json({ error: 'userId required' })
    }

    // Run all three queries in parallel
    const blockedIdsPromise = getBlockedUserIds(userId)
    const userPromise = prisma.user.findUnique({
      where: { tokenId: userId },
      select: { address: true },
    })
    const dmConversationsPromise = prisma.conversation.findMany({
      where: { participants: { some: { userId } } },
      select: {
        id: true,
        participants: { where: { userId }, select: { unreadCount: true } },
      },
    })

    const [blockedIds, user, dmConversations] = await Promise.all([
      blockedIdsPromise,
      userPromise,
      dmConversationsPromise,
    ])

    // Notifications
    const notifWhere: any = { userId, isRead: false, hidden: false }
    if (blockedIds.length > 0) {
      notifWhere.actorId = { notIn: blockedIds }
    }
    const notifications = await prisma.notification.count({ where: notifWhere })

    // Marketplace offers (need to look up all tokens owned by the user's address)
    let offers = 0
    if (user?.address) {
      const ownedUsers = await prisma.user.findMany({
        where: { address: { equals: user.address, mode: 'insensitive' } },
        select: { tokenId: true },
      })
      const tokenIds = ownedUsers.map(u => u.tokenId)
      if (tokenIds.length > 0) {
        // Badge counts every ACTIVE offer, regardless of whether the user has
        // viewed the My Offers tab. The count drops only when the offer is
        // accepted or cancelled (status transitions out of ACTIVE).
        offers = await prisma.marketplaceOffer.count({
          where: { tokenId: { in: tokenIds }, status: 'ACTIVE' },
        })
      }
    }

    res.json({
      notifications,
      offers,
      dmConversations: dmConversations.map((c: { id: string; participants: { unreadCount: number }[] }) => ({
        id: c.id,
        unreadCount: c.participants[0]?.unreadCount || 0,
      })),
    })
  } catch (err: any) {
    console.error('[users/badges] error:', err.message)
    res.status(500).json({ error: 'Failed to fetch badges' })
  }
})

/**
 * GET /api/users/top-followed
 * Returns the top followed users (for suggestions)
 * IMPORTANT: This route must be defined BEFORE /:username to avoid conflicts
 */
router.get('/top-followed', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 20)
    const currentUserId = Number(req.header('x-user-id')) || undefined

    // Get users ordered by follower count, falling back to caw count.
    // likesReceivedCount is read straight from the cached column maintained by
    // CountManager — no per-user prisma.like.count round-trip.
    const users = await prisma.user.findMany({
      where: {
        cawCount: { gt: 0 },
      },
      select: {
        tokenId: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        defaultAvatarId: true,
        image: true,
        followerCount: true,
        likesReceivedCount: true,
      },
      orderBy: [
        { followerCount: 'desc' },
        { cawCount: 'desc' },
      ],
      take: limit
    })

    // Resolve follow state for the current user against each candidate. One Prisma
    // findMany covers all of them in a single round-trip.
    const followsForCurrent = currentUserId
      ? await prisma.follow.findMany({
          where: {
            followerId: currentUserId,
            followingId: { in: users.map(u => u.tokenId) },
          },
          select: { followingId: true, action: true, status: true },
        })
      : []
    const followByTarget = new Map(followsForCurrent.map(f => [f.followingId, f]))

    const usersWithLikes = users.map(u => {
      const f = followByTarget.get(u.tokenId)
      const isFollowing = !!(f && f.action === 'FOLLOW' && f.status === 'SUCCESS')
      const followPending = !!(f && f.status === 'PENDING')
      return {
        tokenId: u.tokenId,
        username: u.username,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
        defaultAvatarId: u.defaultAvatarId,
        image: u.image,
        followerCount: u.followerCount,
        likeCount: u.likesReceivedCount, // API field name = likes received (popularity)
        isFollowing,
        followPending,
      }
    })

    // Filter out blocked users
    let filtered = usersWithLikes
    if (currentUserId) {
      const blockedIds = await getBlockedUserIds(currentUserId)
      if (blockedIds.length > 0) {
        const blockedSet = new Set(blockedIds)
        filtered = usersWithLikes.filter(u => !blockedSet.has(u.tokenId))
      }
    }

    return res.json({ users: filtered })
  } catch (err: any) {
    console.error('GET /api/users/top-followed error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/users/follow-status?followerId=X&followingId=Y
 * Check the current follow status between two users
 * IMPORTANT: This route must be defined BEFORE /:username to avoid conflicts
 */
router.get('/follow-status', async (req, res) => {
  try {
    const followerId = Number(req.query.followerId)
    const followingId = Number(req.query.followingId)

    if (!followerId || !followingId) {
      return res.status(400).json({ error: 'followerId and followingId are required' })
    }

    const follow = await prisma.follow.findUnique({
      where: {
        followerId_followingId: {
          followerId,
          followingId
        }
      },
      select: {
        action: true,
        status: true
      }
    })

    if (!follow) {
      return res.json({
        isFollowing: false,
        isPending: false
      })
    }

    return res.json({
      isFollowing: follow.action === 'FOLLOW' && follow.status === 'SUCCESS',
      isPending: follow.status === 'PENDING'
    })
  } catch (err: any) {
    console.error('GET /api/users/follow-status error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/users/by-token/:tokenId
 * Returns user profile data by tokenId
 * IMPORTANT: This route must be defined BEFORE /:username to avoid conflicts
 */
router.get('/by-token/:tokenId', async (req, res) => {
  try {
    const tokenId = Number(req.params.tokenId)

    if (!tokenId || isNaN(tokenId)) {
      return res.status(400).json({ error: 'Invalid tokenId' })
    }

    const userSelect = {
      tokenId: true,
      username: true,
      displayName: true,
      avatarUrl: true,
      defaultAvatarId: true,
      image: true,
      address: true,
      lastStakedAt: true,
      pendingDepositAmount: true,
      onChainStakeWei: true,
      onChainStakeUpdatedAt: true,
      followerCount: true,
      likedCount: true,
      likesReceivedCount: true,
    } as const

    const user = await prisma.user.findUnique({
      where: { tokenId },
      select: userSelect,
    })

    // Tier 1: no RPC fallback in the request path. If the indexer hasn't
    // produced a row yet, return 202 and let the frontend retry with backoff.
    if (!user) {
      res.setHeader('Retry-After', '3')
      return res.status(202).json({
        error: 'user not yet indexed',
        retryAfterSeconds: 3,
      })
    }

    // Lazy clear pendingDepositAmount: if the L1→L2 deposit has already
    // landed (cached onChainStakeWei >= pending), null the pending fields.
    // Tier 2: this is now a pure DB comparison — no L2 RPC call. The
    // DataCleaner's `refreshOnChainStakeForPendingDeposits` keeps the cache
    // current (1-min cadence) and clears these fields itself; the check
    // here is a fast-path so callers don't see stale "pending" hints during
    // the gap between the deposit landing and the next cleaner pass.
    if (user.pendingDepositAmount && user.onChainStakeWei) {
      const pendingWei = (() => {
        try { return BigInt(user.pendingDepositAmount) } catch { return null }
      })()
      const stakeWei = (() => {
        try { return BigInt(user.onChainStakeWei!) } catch { return null }
      })()
      if (pendingWei !== null && pendingWei > 0n && stakeWei !== null && stakeWei >= pendingWei) {
        await prisma.user.update({
          where: { tokenId },
          data: { pendingDepositAmount: null, lastStakedAt: null },
        })
        user.pendingDepositAmount = null
        user.lastStakedAt = null
        console.log(`[users] Cleared pendingDepositAmount for tokenId=${tokenId} — cached on-chain stake ${stakeWei} >= pending ${pendingWei}`)
      }
    }

    // Tell the frontend whether this sender has any in-flight waiting_for_deposit
    // TxQueue rows. The client uses this as the authoritative "deposit has NOT
    // landed yet" signal for the optimistic localStorage hint: once we report
    // zero waiting rows AND the user has non-zero on-chain stake, the client
    // can safely flush the hint. This is the clean replacement for the old
    // brittle "staked >= pending" comparison which suffered from precision loss.
    const waitingCount = await prisma.txQueue.count({
      where: { senderId: tokenId, status: 'waiting_for_deposit' }
    })

    // API field names: `likeCount` = likes received (popularity); `likedCount` = likes given.
    // Both come straight from the cached User columns maintained by CountManager.
    // If those ever drift, the username route below has a recompute-and-self-heal path;
    // we keep this hot read fast for the address-tokens grid + suggested users, etc.
    // onChainStakeUpdatedAt is surfaced so the FE can show staleness if it
    // cares — typically it doesn't, but the data is available.
    return res.json({
      ...user,
      likeCount: user.likesReceivedCount,
      likedCount: user.likedCount,
      waitingForDepositCount: waitingCount,
    })
  } catch (err: any) {
    console.error('GET /api/users/by-token/:tokenId error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/users/client-auth/:tokenId?clientId=1
 *
 * Returns whether the given tokenId is authenticated with the given clientId,
 * based on the indexed ClientAuth table (populated by ChainSyncService's
 * L2Events indexer). Lets the frontend skip a live readContract call.
 *
 * Auth is a one-way flag: once true, always true for that (clientId, tokenId)
 * pair. So `authenticated: false` here doesn't mean "never will be" — it
 * means "we haven't seen the Authenticated event yet". The frontend may
 * still want to fall back to a live RPC in that case, or rely on the
 * waiting_for_deposit path to take over.
 *
 * IMPORTANT: This route must be defined BEFORE /:username to avoid conflicts
 */
router.get('/client-auth/:tokenId', async (req, res) => {
  try {
    const tokenId = Number(req.params.tokenId)
    const clientId = Number(req.query.clientId) || 1
    // Bound the inputs — tokenIds and clientIds are uint32 on-chain, so they're
    // positive and fit in a Postgres Int4. Reject anything that wouldn't map.
    if (!Number.isInteger(tokenId) || tokenId <= 0 || tokenId > 2_147_483_647) {
      return res.status(400).json({ error: 'Invalid tokenId' })
    }
    if (!Number.isInteger(clientId) || clientId <= 0 || clientId > 2_147_483_647) {
      return res.status(400).json({ error: 'Invalid clientId' })
    }

    const row = await prisma.clientAuth.findUnique({
      where: { clientId_tokenId: { clientId, tokenId } },
      select: { authenticated: true, lastSyncedAt: true },
    })

    return res.json({
      tokenId,
      clientId,
      authenticated: !!row?.authenticated,
      lastSyncedAt: row?.lastSyncedAt ?? null,
    })
  } catch (err: any) {
    console.error('GET /api/users/client-auth/:tokenId error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/users/min-cawonce/:tokenId
 * Returns the minimum safe cawonce for a user (accounting for scheduled posts)
 * This helps prevent cawonce collisions when a user has scheduled posts
 * IMPORTANT: This route must be defined BEFORE /:username to avoid conflicts
 */
router.get('/min-cawonce/:tokenId', async (req, res) => {
  try {
    const tokenId = Number(req.params.tokenId)

    if (!tokenId || isNaN(tokenId)) {
      return res.status(400).json({ error: 'Invalid tokenId' })
    }

    // Find the highest cawonce used by any pending scheduled post for this user
    const maxScheduledCawonce = await prisma.scheduledCaw.aggregate({
      where: {
        userId: tokenId,
        status: 'pending',
        cawonce: { not: null }
      },
      _max: {
        cawonce: true
      }
    })

    // Also check pending/processing TxQueue entries for this user
    // Scan all pending entries since cawonce is inside JSON and can't be sorted by DB
    const pendingTxQueue = await prisma.txQueue.findMany({
      where: {
        senderId: tokenId,
        status: { in: ['pending', 'processing'] },
      },
      select: { payload: true },
    })
    const txQueueCawonces = pendingTxQueue
      .map(e => (e.payload as any)?.data?.cawonce)
      .filter((c): c is number => typeof c === 'number')
    const txQueueMaxCawonce = txQueueCawonces.length > 0
      ? Math.max(...txQueueCawonces)
      : null

    // Also check the highest confirmed Action cawonce.
    // This handles gaps in the on-chain bitmap (e.g. cawonces that were skipped
    // but later slots are used). Without this, nextCawonce on-chain returns
    // the first gap, causing the frontend to reuse already-confirmed cawonces.
    const maxConfirmedAction = await prisma.action.aggregate({
      where: { senderId: tokenId },
      _max: { cawonce: true }
    })

    // The minimum safe cawonce is one higher than the highest in-flight or confirmed cawonce
    const candidates = [
      maxScheduledCawonce._max.cawonce,
      txQueueMaxCawonce,
      maxConfirmedAction._max.cawonce,
    ].filter((v): v is number => v !== null)

    const minSafeCawonce = candidates.length > 0
      ? Math.max(...candidates) + 1
      : null

    return res.json({
      minSafeCawonce,
      hasScheduledPosts: maxScheduledCawonce._max.cawonce !== null
    })
  } catch (err: any) {
    console.error('GET /api/users/min-cawonce/:tokenId error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * POST /api/users/check-cawonces
 * Check which cawonces in a given range are already used (pending or confirmed).
 * Body: { tokenId: number, start: number, count: number }
 * Returns: { used: number[], nextSafe: number }
 *
 * Used before thread submission to find a contiguous block of available cawonces.
 * Only checks a bounded range (max 50) to prevent abuse.
 */
router.post('/check-cawonces', async (req, res) => {
  try {
    const { tokenId, start, count } = req.body
    if (!tokenId || typeof start !== 'number' || typeof count !== 'number') {
      return res.status(400).json({ error: 'tokenId, start, and count are required' })
    }
    const safeCount = Math.min(Math.max(count, 1), 50)
    const searchEnd = start + safeCount + 200 // extended range for finding a contiguous block

    // Single set of queries covering the full search range
    const [confirmedActions, pendingEntries, scheduledEntries] = await Promise.all([
      prisma.action.findMany({
        where: { senderId: tokenId, cawonce: { gte: start, lte: searchEnd } },
        select: { cawonce: true },
      }),
      prisma.txQueue.findMany({
        where: {
          senderId: tokenId,
          status: { in: ['pending', 'processing'] },
        },
        select: { payload: true },
      }),
      prisma.scheduledCaw.findMany({
        where: {
          userId: tokenId,
          status: 'pending',
          cawonce: { gte: start, lte: searchEnd },
        },
        select: { cawonce: true },
      }),
    ])

    const pendingCawonces = pendingEntries
      .map(e => (e.payload as any)?.data?.cawonce)
      .filter((c): c is number => typeof c === 'number' && c >= start && c <= searchEnd)

    const usedSet = new Set([
      ...confirmedActions.map(a => a.cawonce),
      ...pendingCawonces,
      ...scheduledEntries.map(s => s.cawonce!),
    ])

    // Report which cawonces in the originally requested range are used
    const range = Array.from({ length: safeCount }, (_, i) => start + i)
    const used = range.filter(c => usedSet.has(c))

    // Find a starting cawonce where [nextSafe, nextSafe+safeCount-1] are all free
    let nextSafe = start
    while (nextSafe < searchEnd) {
      let blockClear = true
      for (let j = 0; j < safeCount; j++) {
        if (usedSet.has(nextSafe + j)) {
          nextSafe = nextSafe + j + 1
          blockClear = false
          break
        }
      }
      if (blockClear) break
    }

    return res.json({ used, nextSafe })
  } catch (err: any) {
    console.error('POST /api/users/check-cawonces error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * POST /api/users/allocate-cawonce
 * Atomically allocate the next safe cawonce for a sender.
 *
 * Body: { tokenId: number, count?: number }
 * Returns: { cawonces: number[] }
 *
 * The localStorage-based cawonce allocation in the frontend has a race
 * window between "read currentCawonce" and "bump store" that lets two
 * concurrent submissions sign with the same number. The first wins; the
 * rest fail with "Cawonce already used" at simulation. On test.caw.social
 * we observed up to 21 duplicates of a single (sender, cawonce) pair.
 *
 * This endpoint is the authoritative source. It scans every place a
 * cawonce can live (Action, TxQueue pending/processing, ScheduledCaw,
 * existing reservations) for a sender and returns the next gap, then
 * INSERTs into CawonceReservation under a unique constraint to claim
 * it. Concurrent calls racing for the same number get one success and
 * one ON CONFLICT — which we retry transparently with the next gap.
 *
 * The reservation is short-lived: the action submission step deletes
 * it, OR DataCleaner sweeps it after 5 minutes if the client never
 * came back (signature cancelled, browser closed, etc).
 *
 * Speed: one round-trip, no locking. The "find next gap" query uses
 * indexed columns on every table. Bench locally at <10ms per call.
 */
router.post('/allocate-cawonce', async (req, res) => {
  try {
    const tokenId = Number(req.body?.tokenId)
    const requestedCount = Math.min(Math.max(Number(req.body?.count) || 1, 1), 50)
    if (!tokenId || !Number.isFinite(tokenId)) {
      return res.status(400).json({ error: 'tokenId is required' })
    }

    // Tier 1: refuse to allocate for a sender we haven't indexed yet. Without
    // this guard the cawonce reservation would land but downstream sender
    // resolution in /api/actions would 202, leaving the reservation orphaned
    // until the 5-min sweep. The frontend retries on 202 with backoff and the
    // indexer (RawEventsGatherer Mint event handler) populates the row.
    const senderExists = await prisma.user.findUnique({
      where: { tokenId },
      select: { tokenId: true },
    })
    if (!senderExists) {
      res.setHeader('Retry-After', '3')
      return res.status(202).json({
        error: 'user not yet indexed',
        retryAfterSeconds: 3,
      })
    }

    // Sweep stale reservations (>5 min old) for this sender first. Cheap
    // and keeps the per-allocation gap-search query honest. The DataCleaner
    // sweep covers the rest globally on its own schedule, but doing it
    // here too keeps a heavily-used sender from accumulating dead rows
    // between cleaner runs.
    const cleanupCutoff = new Date(Date.now() - 5 * 60_000)
    await prisma.cawonceReservation.deleteMany({
      where: { senderId: tokenId, reservedAt: { lt: cleanupCutoff } },
    })

    // Build the set of in-use cawonces in ONE round-trip via UNION.
    // Action: confirmed on-chain. TxQueue: in-flight. ScheduledCaw: future.
    // CawonceReservation: just-claimed by another concurrent allocator.
    type Row = { cawonce: number }
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT cawonce FROM "Action" WHERE "senderId" = ${tokenId}
      UNION
      SELECT (payload->'data'->>'cawonce')::int AS cawonce FROM "TxQueue"
        WHERE "senderId" = ${tokenId} AND status IN ('pending', 'processing')
      UNION
      SELECT cawonce FROM "ScheduledCaw"
        WHERE "userId" = ${tokenId} AND status = 'pending' AND cawonce IS NOT NULL
      UNION
      SELECT cawonce FROM "CawonceReservation" WHERE "senderId" = ${tokenId}
    `
    const used = new Set<number>(rows.map(r => Number(r.cawonce)).filter(n => Number.isFinite(n)))

    // Walk from 0 picking N consecutive free numbers. We don't require a
    // contiguous block here — that's a thread-submission concern handled
    // by check-cawonces. For single-action allocate we just want the
    // first N available, even if they're scattered. (Threads call
    // check-cawonces separately and get a contiguous block.)
    const allocated: number[] = []
    let cursor = 0
    // Soft cap to prevent pathological scans on a sender with hundreds of
    // thousands of confirmed actions and a sparse pattern. 1M is far beyond
    // any realistic legitimate usage.
    const SCAN_LIMIT = 1_000_000
    while (allocated.length < requestedCount && cursor < SCAN_LIMIT) {
      if (!used.has(cursor)) allocated.push(cursor)
      cursor++
    }
    if (allocated.length < requestedCount) {
      return res.status(500).json({ error: 'Could not find enough free cawonces' })
    }

    // Reserve them. Race retry: ON CONFLICT (senderId, cawonce) returns 0
    // affected rows; if any of our requested numbers got claimed by a
    // concurrent allocator between the gap-scan and this insert, we
    // re-scan and try again. Bounded retry depth — the ratio of claims
    // to free space is essentially zero in practice, so a second loop
    // is paranoia.
    const reserved: number[] = []
    for (const c of allocated) {
      try {
        await prisma.cawonceReservation.create({
          data: { senderId: tokenId, cawonce: c },
        })
        reserved.push(c)
      } catch (createErr: any) {
        // P2002 = unique constraint violation. Another allocator beat us.
        // Skip this cawonce; the next pass will pick up the next gap.
        if (createErr?.code !== 'P2002') throw createErr
      }
    }

    if (reserved.length === requestedCount) {
      return res.json({ cawonces: reserved })
    }

    // Some collided. Re-scan and fill the rest. ONE retry is enough —
    // the chance of a second collision is astronomically low.
    const stillNeeded = requestedCount - reserved.length
    const rows2 = await prisma.$queryRaw<Row[]>`
      SELECT cawonce FROM "Action" WHERE "senderId" = ${tokenId}
      UNION
      SELECT (payload->'data'->>'cawonce')::int AS cawonce FROM "TxQueue"
        WHERE "senderId" = ${tokenId} AND status IN ('pending', 'processing')
      UNION
      SELECT cawonce FROM "ScheduledCaw"
        WHERE "userId" = ${tokenId} AND status = 'pending' AND cawonce IS NOT NULL
      UNION
      SELECT cawonce FROM "CawonceReservation" WHERE "senderId" = ${tokenId}
    `
    const used2 = new Set<number>(rows2.map(r => Number(r.cawonce)).filter(n => Number.isFinite(n)))
    let c2 = 0
    while (reserved.length < requestedCount && c2 < SCAN_LIMIT) {
      if (!used2.has(c2)) {
        try {
          await prisma.cawonceReservation.create({
            data: { senderId: tokenId, cawonce: c2 },
          })
          reserved.push(c2)
          used2.add(c2)
        } catch (e: any) {
          if (e?.code !== 'P2002') throw e
          used2.add(c2) // someone else just claimed it; move on
        }
        if (reserved.length >= requestedCount) break
      }
      c2++
      if (reserved.length >= requestedCount) break
    }
    void stillNeeded // documented intent; loop above does the work

    if (reserved.length < requestedCount) {
      // Roll back what we did claim — the caller asked for N and we can't
      // give N, so don't leak partial reservations.
      await prisma.cawonceReservation.deleteMany({
        where: { senderId: tokenId, cawonce: { in: reserved } },
      })
      return res.status(503).json({ error: 'Allocation contention — please retry' })
    }
    return res.json({ cawonces: reserved })
  } catch (err: any) {
    console.error('POST /api/users/allocate-cawonce error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * POST /api/users/release-cawonce
 * Release reserved cawonces that the client decided not to use (signature
 * cancelled, validation failed pre-submit, etc). The DataCleaner sweep
 * also catches abandoned reservations after 5 minutes; this endpoint is
 * for the well-behaved client returning unused allocations promptly so
 * the next allocator doesn't see them as taken.
 *
 * Body: { tokenId: number, cawonces: number[] }
 * Idempotent — deleting a non-existent row is a no-op.
 */
router.post('/release-cawonce', async (req, res) => {
  try {
    const tokenId = Number(req.body?.tokenId)
    const cawonces: unknown = req.body?.cawonces
    if (!tokenId || !Array.isArray(cawonces)) {
      return res.status(400).json({ error: 'tokenId and cawonces[] are required' })
    }
    const nums = (cawonces as any[]).map(Number).filter(n => Number.isFinite(n))
    if (nums.length === 0) return res.json({ released: 0 })
    const result = await prisma.cawonceReservation.deleteMany({
      where: { senderId: tokenId, cawonce: { in: nums } },
    })
    return res.json({ released: result.count })
  } catch (err: any) {
    console.error('POST /api/users/release-cawonce error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/users/by-address/:address
 * Returns user profile data by wallet address
 * IMPORTANT: This route must be defined BEFORE /:username to avoid conflicts
 */
router.get('/by-address/:address', async (req, res) => {
  try {
    const { address } = req.params
    const normalizedAddress = address.toLowerCase()

    // Fetch user by address
    const user = await prisma.user.findFirst({
      where: { address: normalizedAddress },
      select: {
        address: true,
        tokenId: true,
        username: true,
        image: true,
        displayName: true,
        avatarUrl: true,
        defaultAvatarId: true,
        bio: true,
        createdAt: true,
      }
    })

    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    return res.json(user)
  } catch (err: any) {
    console.error('GET /api/users/by-address/:address error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/users/onboarding/:username
 * Returns the user's current onboarding step
 * IMPORTANT: This route must be defined BEFORE /:username to avoid conflicts
 */
router.get('/onboarding/:username', async (req, res) => {
  try {
    const { username } = req.params

    const user = await prisma.user.findUnique({
      where: { username },
      select: { onboardingStep: true }
    })

    if (!user) {
      return res.json({ onboardingStep: -1 })
    }

    return res.json({ onboardingStep: user.onboardingStep })
  } catch (err: any) {
    console.error('GET /api/users/onboarding/:username error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * PATCH /api/users/onboarding/:username
 * Update the user's onboarding step (0-5)
 * IMPORTANT: This route must be defined BEFORE /:username to avoid conflicts
 */
router.patch('/onboarding/:username', async (req, res) => {
  try {
    const { username } = req.params
    const { step } = req.body

    if (typeof step !== 'number' || step < 0 || step > 5) {
      return res.status(400).json({ error: 'step must be a number between 0 and 5' })
    }

    const user = await prisma.user.findUnique({
      where: { username },
      select: { tokenId: true }
    })

    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    await prisma.user.update({
      where: { username },
      data: { onboardingStep: step }
    })

    return res.json({ success: true, onboardingStep: step })
  } catch (err: any) {
    console.error('PATCH /api/users/onboarding/:username error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * PATCH /api/users/:tokenId/profile
 * Off-chain profile update. Saves profile fields directly to the DB without
 * touching the chain. Requires a valid session that owns the target tokenId.
 * Sets profileSource to "offchain". On-chain updates (via ActionProcessor)
 * will always override these.
 * IMPORTANT: This route must be defined BEFORE /:username to avoid conflicts.
 */
router.patch(
  '/:tokenId/profile',
  requireAuth({ lookup: async (req) => Number(req.params.tokenId) }),
  async (req, res) => {
    try {
      const tokenId = Number(req.params.tokenId)
      if (!tokenId || isNaN(tokenId)) {
        return res.status(400).json({ error: 'Invalid tokenId' })
      }

      const { displayName, bio, location, website, avatarUrl, coverPhotoUrl, defaultAvatarId } = req.body ?? {}

      const updateData: Record<string, any> = {}
      const incoming: Record<string, unknown> = {
        displayName, bio, location, website, avatarUrl, coverPhotoUrl,
      }

      // Handle defaultAvatarId separately (integer, not string)
      if (defaultAvatarId !== undefined) {
        const id = parseInt(String(defaultAvatarId))
        if (id >= 1 && id <= 100) updateData.defaultAvatarId = id
      }

      for (const [field, rawValue] of Object.entries(incoming)) {
        if (rawValue === undefined) continue
        if (rawValue !== null && typeof rawValue !== 'string') {
          return res.status(400).json({ error: `${field} must be a string` })
        }
        const trimmed = (rawValue ?? '').toString().trim()
        const limit = PROFILE_FIELD_LIMITS[field]
        updateData[field] = limit && trimmed.length > limit ? trimmed.substring(0, limit) : trimmed
      }

      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ error: 'No profile fields provided' })
      }

      const updated = await prisma.user.update({
        where: { tokenId },
        data: { ...updateData, profileSource: 'offchain' },
        select: {
          tokenId: true,
          username: true,
          displayName: true,
          bio: true,
          location: true,
          website: true,
          avatarUrl: true,
          defaultAvatarId: true,
          coverPhotoUrl: true,
          profileSource: true,
          profileUpdatePending: true,
        },
      })

      return res.json({ user: updated })
    } catch (err: any) {
      console.error('PATCH /api/users/:tokenId/profile error', err)
      return res.status(500).json({ error: 'Internal server error' })
    }
  }
)

/**
 * GET /api/users/:username
 * Returns user profile data with accurate counts
 */
router.get('/:username', async (req, res) => {
  try {
    const { username } = req.params
    const currentUserId = Number(req.header('x-user-id')) || undefined

    // Fetch user with counts
    const user = await prisma.user.findUnique({
      where: { username },
      select: {
        address: true,
        tokenId: true,
        username: true,
        image: true,
        createdAt: true,
        updatedAt: true,
        // Profile fields
        bio: true,
        displayName: true,
        location: true,
        website: true,
        avatarUrl: true,
        defaultAvatarId: true,
        coverPhotoUrl: true,
        profileUpdatePending: true,
        profileSource: true,
        lastStakedAt: true,
        // Counter cache fields
        cawCount: true,
        recawCount: true,
        followerCount: true,
        followingCount: true,
        likedCount: true,
        likesReceivedCount: true,
      }
    })

    if (!user) {
      // User not in DB. The frontend will do its own on-chain availability
      // check via CawProfileMinter.idByUsername to distinguish "never claimed"
      // from "exists on-chain but not yet synced" — we keep that off the
      // server so unrelated requests aren't delayed by an RPC round-trip.
      return res.status(404).json({ error: 'User not found' })
    }

    // Recompute likes (received + given) live for the canonical profile view —
    // self-heals any drift in the cached counters back into the User row below.
    // Other hot paths (by-token, top-followed) read the cache directly.
    const [likeCount, likedCount] = await Promise.all([
      prisma.like.count({
        where: { caw: { userId: user.tokenId }, action: ActionType.LIKE },
      }),
      prisma.like.count({
        where: { userId: user.tokenId, action: ActionType.LIKE },
      }),
    ])

    // Check if current user is following this user
    let isFollowing = false
    let followPending = false
    if (currentUserId && currentUserId !== user.tokenId) {
      const follow = await prisma.follow.findUnique({
        where: {
          followerId_followingId: {
            followerId: currentUserId,
            followingId: user.tokenId
          }
        },
        select: {
          action: true,
          status: true
        }
      })

      if (follow) {
        // Only set isFollowing if action is FOLLOW and status is SUCCESS
        isFollowing = follow.action === 'FOLLOW' && follow.status === 'SUCCESS'
        // Set pending if status is PENDING
        followPending = follow.status === 'PENDING'
      }
    }

    // Check if current user has tipped this profile (profile tips have no cawId)
    let hasTipped = false
    let tipPending = false
    if (currentUserId && currentUserId !== user.tokenId) {
      const profileTip = await prisma.tip.findFirst({
        where: {
          senderId: currentUserId,
          recipientId: user.tokenId,
          cawId: null
        },
        orderBy: { createdAt: 'desc' },
        select: { pending: true }
      })

      if (profileTip) {
        hasTipped = !profileTip.pending
        tipPending = profileTip.pending
      }
    }

    // Check if current user has blocked this profile user
    let isBlocked = false
    if (currentUserId && currentUserId !== user.tokenId) {
      const blockedIds = await getBlockedUserIds(currentUserId)
      isBlocked = blockedIds.includes(user.tokenId)
    }

    // Count replies and media posts
    const mediaConditions = [
      { hasImage: true },
      { hasVideo: true },
      { content: { contains: '.gif', mode: 'insensitive' as const } },
      { content: { contains: '.jpg', mode: 'insensitive' as const } },
      { content: { contains: '.jpeg', mode: 'insensitive' as const } },
      { content: { contains: '.png', mode: 'insensitive' as const } },
      { content: { contains: '.webp', mode: 'insensitive' as const } },
      { content: { contains: 'giphy.com', mode: 'insensitive' as const } },
      { content: { contains: 'imgur.com', mode: 'insensitive' as const } },
      { content: { contains: 'tenor.com', mode: 'insensitive' as const } },
    ]

    const [replyCount, mediaCount] = await Promise.all([
      prisma.caw.count({
        where: {
          userId: user.tokenId,
          action: 'CAW',
          originalCawId: { not: null },
          status: 'SUCCESS',
        }
      }),
      prisma.caw.count({
        where: {
          userId: user.tokenId,
          status: 'SUCCESS',
          OR: mediaConditions,
        }
      }),
    ])

    // Compute actual follow counts from the follow table (cached counters can drift)
    const [actualFollowerCount, actualFollowingCount] = await Promise.all([
      prisma.follow.count({
        where: { followingId: user.tokenId, action: 'FOLLOW', status: 'SUCCESS' }
      }),
      prisma.follow.count({
        where: { followerId: user.tokenId, action: 'FOLLOW', status: 'SUCCESS' }
      }),
    ])

    // Fix cached counters if they drifted (followers + likes both live here so
    // any stale row visited via the canonical profile path gets healed).
    const drift: any = {}
    if (user.followerCount !== actualFollowerCount) drift.followerCount = actualFollowerCount
    if (user.followingCount !== actualFollowingCount) drift.followingCount = actualFollowingCount
    if (user.likesReceivedCount !== likeCount) drift.likesReceivedCount = likeCount
    if (user.likedCount !== likedCount) drift.likedCount = likedCount
    if (Object.keys(drift).length > 0) {
      prisma.user.update({
        where: { tokenId: user.tokenId },
        data: drift,
      }).catch(() => {}) // fire-and-forget
    }

    const response = {
      ...user,
      cawCount: Math.max(0, user.cawCount - replyCount) + (user.recawCount || 0),
      recawCount: user.recawCount || 0,
      followerCount: actualFollowerCount,
      followingCount: actualFollowingCount,
      likeCount,
      likedCount,
      replyCount,
      mediaCount,
      isFollowing,
      followPending,
      hasTipped,
      tipPending,
      isBlocked,
    }

    return res.json(response)
  } catch (err: any) {
    console.error('GET /api/users/:username error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/users/:username/followers
 * Returns list of users who follow this user
 */
router.get('/:username/followers', async (req, res) => {
  try {
    const { username } = req.params
    const currentUserId = Number(req.header('x-user-id')) || undefined
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100)
    const cursor = req.query.cursor ? Number(req.query.cursor) : undefined

    // Get the user
    const user = await prisma.user.findUnique({
      where: { username },
      select: { tokenId: true }
    })

    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Get followers
    const followers = await prisma.follow.findMany({
      where: {
        followingId: user.tokenId,
        action: ActionType.FOLLOW
      },
      take: limit + 1,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        follower: {
          select: {
            tokenId: true,
            username: true,
            image: true,
            displayName: true,
            bio: true,
            avatarUrl: true
          }
        }
      }
    })

    const hasMore = followers.length > limit
    const followersList = followers.slice(0, limit)
    const nextCursor = hasMore ? followers[limit - 1].id : undefined

    // For each follower, check if current user is following them
    const items = await Promise.all(followersList.map(async (f) => {
      let isFollowing = false
      let followPending = false

      if (currentUserId && currentUserId !== f.follower.tokenId) {
        const follow = await prisma.follow.findUnique({
          where: {
            followerId_followingId: {
              followerId: currentUserId,
              followingId: f.follower.tokenId
            }
          },
          select: {
            action: true,
            status: true
          }
        })

        if (follow) {
          isFollowing = follow.action === 'FOLLOW' && follow.status === 'SUCCESS'
          followPending = follow.status === 'PENDING'
        }
      }

      return {
        ...f.follower,
        isFollowing,
        followPending
      }
    }))

    // Filter out blocked users
    let filtered = items
    if (currentUserId) {
      const blockedIds = await getBlockedUserIds(currentUserId)
      if (blockedIds.length > 0) {
        const blockedSet = new Set(blockedIds)
        filtered = items.filter(u => !blockedSet.has(u.tokenId))
      }
    }

    return res.json({ items: filtered, nextCursor })
  } catch (err: any) {
    console.error('GET /api/users/:username/followers error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/users/:username/following
 * Returns list of users this user follows
 */
router.get('/:username/following', async (req, res) => {
  try {
    const { username } = req.params
    const currentUserId = Number(req.header('x-user-id')) || undefined
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100)
    const cursor = req.query.cursor ? Number(req.query.cursor) : undefined

    // Get the user
    const user = await prisma.user.findUnique({
      where: { username },
      select: { tokenId: true }
    })

    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Get following
    const following = await prisma.follow.findMany({
      where: {
        followerId: user.tokenId,
        action: ActionType.FOLLOW
      },
      take: limit + 1,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        following: {
          select: {
            tokenId: true,
            username: true,
            image: true,
            displayName: true,
            bio: true,
            avatarUrl: true
          }
        }
      }
    })

    const hasMore = following.length > limit
    const followingList = following.slice(0, limit)
    const nextCursor = hasMore ? following[limit - 1].id : undefined

    // For each following user, check if current user is following them
    const items = await Promise.all(followingList.map(async (f) => {
      let isFollowing = false
      let followPending = false

      if (currentUserId && currentUserId !== f.following.tokenId) {
        const follow = await prisma.follow.findUnique({
          where: {
            followerId_followingId: {
              followerId: currentUserId,
              followingId: f.following.tokenId
            }
          },
          select: {
            action: true,
            status: true
          }
        })

        if (follow) {
          isFollowing = follow.action === 'FOLLOW' && follow.status === 'SUCCESS'
          followPending = follow.status === 'PENDING'
        }
      }

      return {
        ...f.following,
        isFollowing,
        followPending
      }
    }))

    // Filter out blocked users
    let filtered = items
    if (currentUserId) {
      const blockedIds = await getBlockedUserIds(currentUserId)
      if (blockedIds.length > 0) {
        const blockedSet = new Set(blockedIds)
        filtered = items.filter(u => !blockedSet.has(u.tokenId))
      }
    }

    return res.json({ items: filtered, nextCursor })
  } catch (err: any) {
    console.error('GET /api/users/:username/following error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/users/search/:query
 * Search for users by username prefix (for @mention autocomplete)
 */
router.get('/search/:query', async (req, res) => {
  try {
    const { query } = req.params
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 20)

    if (!query || query.length < 1) {
      return res.json({ users: [] })
    }

    // Search for users whose username starts with the query (case insensitive)
    const users = await prisma.user.findMany({
      where: {
        username: {
          startsWith: query.toLowerCase(),
          mode: 'insensitive'
        }
      },
      select: {
        tokenId: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        defaultAvatarId: true,
        image: true,
      },
      take: limit,
      orderBy: {
        username: 'asc'
      }
    })

    // Filter out blocked users
    const currentUserId = Number(req.header('x-user-id')) || undefined
    let filtered = users
    if (currentUserId) {
      const blockedIds = await getBlockedUserIds(currentUserId)
      if (blockedIds.length > 0) {
        const blockedSet = new Set(blockedIds)
        filtered = users.filter(u => !blockedSet.has(u.tokenId))
      }
    }

    return res.json({ users: filtered })
  } catch (err: any) {
    console.error('GET /api/users/search/:query error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * PATCH /api/users/:username
 * Update user fields (lastStakedAt and pendingDepositAmount for LayerZero tracking)
 */
router.patch('/:username', async (req, res) => {
  try {
    const { username } = req.params
    const { lastStakedAt, pendingDepositAmount } = req.body

    if (!lastStakedAt && pendingDepositAmount === undefined) {
      return res.status(400).json({ error: 'No update fields provided' })
    }

    const data: any = {}
    if (lastStakedAt) data.lastStakedAt = new Date(lastStakedAt)
    if (pendingDepositAmount !== undefined) data.pendingDepositAmount = String(pendingDepositAmount)

    await prisma.user.update({
      where: { username },
      data,
    })

    return res.json({ success: true })
  } catch (err: any) {
    console.error('PATCH /api/users/:username error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
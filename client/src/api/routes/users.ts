// src/api/routes/users.ts
import { Router } from 'express'
import { Contract, JsonRpcProvider, WebSocketProvider } from 'ethers'
import { makeJsonRpcProvider, makeWebSocketProvider } from '../../utils/rpcProvider'
import { prisma } from '../../prismaClient'
import { ActionType } from '@prisma/client'
import { findOrCreateUser, StaleTokenError } from '../../services/UserService'
import { getBlockedUserIds } from '../shared/blockUtils'
import { requireAuth } from '../middleware/auth'
import { CAW_NAMES_L2_ADDRESS } from '../../abi/addresses'
import { cawNameL2Abi } from '../../abi/generated'

// Lazy-cached L2 read contract for checking on-chain staked balance.
let _l2ReadContract: Contract | null = null
function getL2ReadContract(): Contract | null {
  if (_l2ReadContract) return _l2ReadContract
  const rpcUrl = process.env.L2_RPC_URL_HTTP || process.env.L2_RPC_URL
  if (!rpcUrl) return null
  const provider = rpcUrl.startsWith('wss://') || rpcUrl.startsWith('ws://')
    ? makeWebSocketProvider(rpcUrl)
    : makeJsonRpcProvider(rpcUrl)
  _l2ReadContract = new Contract(CAW_NAMES_L2_ADDRESS, cawNameL2Abi as any, provider)
  return _l2ReadContract
}

/**
 * Reads the current on-chain staked balance for a tokenId on L2. Returns null on failure.
 */
async function readOnChainStake(tokenId: number): Promise<bigint | null> {
  try {
    const contract = getL2ReadContract()
    if (!contract) {
      console.warn(`[users] readOnChainStake: no L2 RPC configured`)
      return null
    }
    const result = await contract.getTokens([tokenId])
    // ethers v6 returns a Result (array-like, also indexable by name).
    const token = result?.[0]
    if (!token) {
      console.warn(`[users] readOnChainStake: no token returned for tokenId=${tokenId}`)
      return null
    }
    // Token struct: [tokenId, balance, username, cawBalance, nextCawonce]
    // Access by index (3) because Result named access can be finicky on nested tuples.
    const cawBalance = token.cawBalance ?? token[3]
    const asBigInt = BigInt(cawBalance?.toString() ?? '0')
    console.log(`[users] readOnChainStake tokenId=${tokenId} cawBalance=${asBigInt}`)
    return asBigInt
  } catch (err) {
    console.warn(`[users] readOnChainStake failed for tokenId=${tokenId}:`, (err as Error).message)
    return null
  }
}

// Throttle the pending-deposit on-chain check to at most once per 15s
// per tokenId. Without this, every profile refresh by a user with a
// pending deposit triggers an L2 RPC call. The DataCleaner watcher
// independently polls so we won't miss the clearing event.
const depositPollCache = new Map<number, number>()
const DEPOSIT_POLL_THROTTLE_MS = 15_000
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000
  for (const [k, t] of depositPollCache) {
    if (t < cutoff) depositPollCache.delete(k)
  }
}, 60_000)

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
 * Ensure a user record exists in the DB for a given tokenId.
 * If not found in DB, queries L1/L2 contracts to verify ownership and username
 * on-chain before creating. Will fail if the token doesn't exist on-chain.
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

    // /api/users/ensure is called from PostMintOnboarding when the user has
    // just minted a fresh name — they need to complete the welcome flow.
    // Pass onboardingStep: 0 so the upsert creates them at the start of the
    // flow (existing users are unchanged — upsert's update is a no-op).
    console.log(`[/api/users/ensure] Calling findOrCreateUser(${tokenId})...`)
    const resultTokenId = await findOrCreateUser(Number(tokenId), { onboardingStep: 0 })
    const findDuration = Date.now() - startTime
    console.log(`[/api/users/ensure] findOrCreateUser completed in ${findDuration}ms, resultTokenId=${resultTokenId}`)

    console.log(`[/api/users/ensure] Fetching user from DB...`)
    const user = await prisma.user.findUnique({
      where: { tokenId: resultTokenId },
      select: { tokenId: true, username: true, address: true }
    })
    const totalDuration = Date.now() - startTime
    console.log(`[/api/users/ensure] SUCCESS in ${totalDuration}ms, user=${JSON.stringify(user)}`)

    return res.json({ user })
  } catch (error: any) {
    const totalDuration = Date.now() - startTime
    if (error instanceof StaleTokenError) {
      console.warn(`[/api/users/ensure] Token not found on chain after ${totalDuration}ms: ${error.message}`)
      return res.status(404).json({ error: 'Token not found on current contract. It may still be propagating — try again in a moment.' })
    }
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
      select: { address: true, lastViewedOffersAt: true },
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
        const offerWhere: any = { tokenId: { in: tokenIds }, status: 'ACTIVE' }
        if (user.lastViewedOffersAt) offerWhere.createdAt = { gt: user.lastViewedOffersAt }
        offers = await prisma.marketplaceOffer.count({ where: offerWhere })
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

    // Get users ordered by follower count, falling back to caw count
    // Only include users who have posted at least once
    const users = await prisma.user.findMany({
      where: {
        cawCount: { gt: 0 },
      },
      select: {
        tokenId: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        image: true,
        followerCount: true,
      },
      orderBy: [
        { followerCount: 'desc' },
        { cawCount: 'desc' },
      ],
      take: limit
    })

    // Get total likes received for each user
    const usersWithLikes = await Promise.all(users.map(async (user) => {
      const likeCount = await prisma.like.count({
        where: {
          caw: { userId: user.tokenId },
          action: ActionType.LIKE
        }
      })

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
          isFollowing = follow.action === 'FOLLOW' && follow.status === 'SUCCESS'
          followPending = follow.status === 'PENDING'
        }
      }

      return {
        ...user,
        likeCount,
        isFollowing,
        followPending
      }
    }))

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

    let user = await prisma.user.findUnique({
      where: { tokenId },
      select: {
        tokenId: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        image: true,
        address: true,
        lastStakedAt: true,
        pendingDepositAmount: true,
      }
    })

    // Auto-create from chain if not in DB
    if (!user) {
      try {
        await findOrCreateUser(tokenId)
        user = await prisma.user.findUnique({
          where: { tokenId },
          select: {
            tokenId: true, username: true, displayName: true, avatarUrl: true,
            image: true, address: true, lastStakedAt: true, pendingDepositAmount: true,
          }
        })
      } catch (err: any) {
        console.log(`[users/by-token] Auto-create failed for tokenId ${tokenId}: ${err.message?.slice(0, 100)}`)
      }
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Lazy clear pendingDepositAmount: if the L1→L2 deposit has landed on L2
    // (on-chain staked balance >= pending amount), null the fields so UI and
    // validator stop treating the user as "waiting for deposit".
    if (user.pendingDepositAmount) {
      const pendingWei = (() => {
        try { return BigInt(user.pendingDepositAmount) } catch { return null }
      })()
      if (pendingWei !== null && pendingWei > 0n) {
        // Throttle the on-chain check: if we verified within the last 15s,
        // skip the RPC and let the DataCleaner watcher handle it on its own
        // schedule. Without this, every profile refresh triggers an L2 read.
        const lastCheck = depositPollCache.get(tokenId) || 0
        if (Date.now() - lastCheck < DEPOSIT_POLL_THROTTLE_MS) {
          console.log(`[users] by-token tokenId=${tokenId}: pending deposit check throttled (last checked ${Math.round((Date.now() - lastCheck)/1000)}s ago)`)
        } else {
          depositPollCache.set(tokenId, Date.now())
          const onChainStake = await readOnChainStake(tokenId)
          console.log(`[users] by-token tokenId=${tokenId}: pending=${pendingWei} onChainStake=${onChainStake}`)
          if (onChainStake !== null && onChainStake >= pendingWei) {
            await prisma.user.update({
              where: { tokenId },
              data: { pendingDepositAmount: null, lastStakedAt: null },
            })
            user.pendingDepositAmount = null
            user.lastStakedAt = null
            depositPollCache.delete(tokenId) // no longer pending; drop the throttle
            console.log(`[users] Cleared pendingDepositAmount for tokenId=${tokenId} — deposit of ${pendingWei} landed (on-chain: ${onChainStake})`)
          } else {
            console.log(`[users] Pending deposit still in flight for tokenId=${tokenId} (on-chain ${onChainStake} < pending ${pendingWei})`)
          }
        }
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

    return res.json({ ...user, waitingForDepositCount: waitingCount })
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

      const { displayName, bio, location, website, avatarUrl, coverPhotoUrl } = req.body ?? {}

      const updateData: Record<string, string> = {}
      const incoming: Record<string, unknown> = {
        displayName, bio, location, website, avatarUrl, coverPhotoUrl,
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
        coverPhotoUrl: true,
        profileUpdatePending: true,
        profileSource: true,
        lastStakedAt: true,
        // Counter cache fields
        cawCount: true,
        recawCount: true,
        followerCount: true,
        followingCount: true,
      }
    })

    if (!user) {
      // User not in DB. The frontend will do its own on-chain availability
      // check via CawNameMinter.idByUsername to distinguish "never claimed"
      // from "exists on-chain but not yet synced" — we keep that off the
      // server so unrelated requests aren't delayed by an RPC round-trip.
      return res.status(404).json({ error: 'User not found' })
    }

    // Get actual like count (total likes received on all caws)
    const likeCount = await prisma.like.count({
      where: {
        caw: {
          userId: user.tokenId
        },
        action: ActionType.LIKE
      }
    })

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

    // Fix cached counters if they drifted
    if (user.followerCount !== actualFollowerCount || user.followingCount !== actualFollowingCount) {
      prisma.user.update({
        where: { tokenId: user.tokenId },
        data: { followerCount: actualFollowerCount, followingCount: actualFollowingCount }
      }).catch(() => {}) // fire-and-forget
    }

    const response = {
      ...user,
      cawCount: Math.max(0, user.cawCount - replyCount) + (user.recawCount || 0),
      recawCount: user.recawCount || 0,
      followerCount: actualFollowerCount,
      followingCount: actualFollowingCount,
      likeCount,
      replyCount,
      mediaCount,
      isFollowing,
      followPending,
      hasTipped,
      tipPending,
      isBlocked,
    }

    console.log(`[users API] ${username}: followerCount=${actualFollowerCount}, followingCount=${actualFollowingCount}`)

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
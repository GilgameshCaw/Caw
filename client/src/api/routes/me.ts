import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { extractSession } from '../middleware/auth'

const router = Router()

/**
 * GET /api/me
 * Bootstrap endpoint — aggregates profile, deposit state, badges, DM identity,
 * blocks, cawonce, and failed retries into a single response so the frontend
 * can hydrate in one round-trip instead of ~10.
 */
router.get('/', async (req, res) => {
  try {
    await extractSession(req)

    if (!req.sessionData || req.sessionData.authorizedTokenIds.length === 0) {
      return res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Valid session with authorized tokens required' })
    }

    const tokenId = req.sessionData.authorizedTokenIds[0]

    // --- Run all queries in parallel ---
    const [
      userResult,
      depositResult,
      badgesResult,
      dmIdentityResult,
      blocksResult,
      cawonceResult,
      failedRetriesResult,
    ] = await Promise.all([
      // 1. User profile
      fetchUser(tokenId),
      // 2. Deposit / staking state
      fetchDeposit(tokenId),
      // 3. Badge counts
      fetchBadges(tokenId),
      // 4. DM identity
      fetchDmIdentity(tokenId),
      // 5. Blocked user IDs
      fetchBlocks(tokenId),
      // 6. Min safe cawonce
      fetchCawonce(tokenId),
      // 7. Failed cawonce retries
      fetchFailedRetries(tokenId),
    ])

    return res.json({
      user: userResult,
      deposit: depositResult,
      badges: badgesResult,
      dmIdentity: dmIdentityResult,
      blocks: blocksResult,
      cawonce: cawonceResult,
      failedRetries: failedRetriesResult,
    })
  } catch (err: any) {
    console.error('GET /api/me error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// --- Individual fetch helpers (each catches its own errors) ---

async function fetchUser(tokenId: number) {
  try {
    const user = await prisma.user.findUnique({
      where: { tokenId },
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
        address: true,
        image: true,
        profileSource: true,
        profileUpdatePending: true,
        onboardingStep: true,
        cawCount: true,
        followerCount: true,
        followingCount: true,
        // Per-profile X badge visibility — the FE settings panel needs
        // both the link state and this toggle to render correctly.
        xBadgeVisible: true,
      },
    })
    if (!user) return null

    // X link is wallet-scoped (WalletXLink keyed by address). Look it up
    // alongside the User row so /api/me delivers the full X state in one
    // shot — including links not currently visible on this profile, so
    // the settings panel can render the per-profile toggle row for every
    // sibling profile.
    let xLink: { xHandle: string; xFollowerBucket: number | null; linkedAt: Date } | null = null
    if (user.address) {
      const link = await prisma.walletXLink.findUnique({
        where:  { address: user.address.toLowerCase() },
        select: { xHandle: true, xFollowerBucket: true, linkedAt: true },
      })
      xLink = link ?? null
    }

    return {
      ...user,
      // Backwards-compat shape for the FE: surface xHandle / xBucket /
      // xLinkedAt at the top level. They're null when the wallet hasn't
      // linked an X account, OR when this profile has hidden the badge.
      xHandle:         user.xBadgeVisible && xLink ? xLink.xHandle : null,
      xFollowerBucket: user.xBadgeVisible && xLink ? xLink.xFollowerBucket : null,
      xLinkedAt:       xLink?.linkedAt ?? null,
      // Always include the underlying link state so the settings panel
      // can show "your wallet IS linked but this profile has the badge
      // hidden" cleanly, separate from "your wallet has no link".
      xLink: xLink ? { xHandle: xLink.xHandle, xFollowerBucket: xLink.xFollowerBucket } : null,
    }
  } catch (err: any) {
    console.error('[/api/me] fetchUser error:', err.message)
    return null
  }
}

async function fetchDeposit(tokenId: number) {
  try {
    const user = await prisma.user.findUnique({
      where: { tokenId },
      select: {
        lastStakedAt: true,
        pendingDepositAmount: true,
      },
    })

    const waitingForDepositCount = await prisma.txQueue.count({
      where: { senderId: tokenId, status: 'waiting_for_deposit' },
    })

    return {
      lastStakedAt: user?.lastStakedAt ?? null,
      pendingDepositAmount: user?.pendingDepositAmount ?? null,
      waitingForDepositCount,
    }
  } catch (err: any) {
    console.error('[/api/me] fetchDeposit error:', err.message)
    return { lastStakedAt: null, pendingDepositAmount: null, waitingForDepositCount: 0 }
  }
}

async function fetchBadges(tokenId: number) {
  try {
    // Blocked IDs for filtering notifications
    const blockedIds = await prisma.block.findMany({
      where: { blockerId: tokenId },
      select: { blockedId: true },
    }).then(rows => rows.map(r => r.blockedId))

    // Notifications (excluding blocked actors)
    const notifWhere: any = { userId: tokenId, isRead: false, hidden: false }
    if (blockedIds.length > 0) {
      notifWhere.actorId = { notIn: blockedIds }
    }
    const notifications = await prisma.notification.count({ where: notifWhere })

    // Marketplace offers — count every ACTIVE offer received. Drops only when
    // the offer is accepted or cancelled, never on view.
    const user = await prisma.user.findUnique({
      where: { tokenId },
      select: { address: true },
    })
    let offers = 0
    if (user?.address) {
      const ownedUsers = await prisma.user.findMany({
        where: { address: { equals: user.address, mode: 'insensitive' } },
        select: { tokenId: true },
      })
      const tokenIds = ownedUsers.map(u => u.tokenId)
      if (tokenIds.length > 0) {
        offers = await prisma.marketplaceOffer.count({
          where: { tokenId: { in: tokenIds }, status: 'ACTIVE' },
        })
      }
    }

    // DM conversations with unread counts
    const dmConversations = await prisma.conversation.findMany({
      where: { participants: { some: { userId: tokenId } } },
      select: {
        id: true,
        participants: { where: { userId: tokenId }, select: { unreadCount: true } },
      },
    })

    return {
      notifications,
      offers,
      dmConversations: dmConversations.map((c: { id: string; participants: { unreadCount: number }[] }) => ({
        id: c.id,
        unreadCount: c.participants[0]?.unreadCount || 0,
      })),
    }
  } catch (err: any) {
    console.error('[/api/me] fetchBadges error:', err.message)
    return { notifications: 0, offers: 0, dmConversations: [] }
  }
}

async function fetchDmIdentity(tokenId: number) {
  try {
    const identity = await prisma.dmIdentity.findUnique({
      where: { userId: tokenId },
      select: { publicKey: true },
    })
    return {
      hasIdentity: identity !== null,
      publicKey: identity?.publicKey ?? null,
    }
  } catch (err: any) {
    console.error('[/api/me] fetchDmIdentity error:', err.message)
    return { hasIdentity: false, publicKey: null }
  }
}

async function fetchBlocks(tokenId: number) {
  try {
    const blocks = await prisma.block.findMany({
      where: { blockerId: tokenId },
      select: { blockedId: true },
    })
    return { blockedUserIds: blocks.map(b => b.blockedId) }
  } catch (err: any) {
    console.error('[/api/me] fetchBlocks error:', err.message)
    return { blockedUserIds: [] }
  }
}

async function fetchCawonce(tokenId: number) {
  try {
    // Highest cawonce from pending scheduled posts
    const maxScheduledCawonce = await prisma.scheduledCaw.aggregate({
      where: {
        userId: tokenId,
        status: 'pending',
        cawonce: { not: null },
      },
      _max: { cawonce: true },
    })

    // Highest cawonce from pending/processing TxQueue entries
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

    // Highest confirmed Action cawonce
    const maxConfirmedAction = await prisma.action.aggregate({
      where: { senderId: tokenId },
      _max: { cawonce: true },
    })

    const candidates = [
      maxScheduledCawonce._max.cawonce,
      txQueueMaxCawonce,
      maxConfirmedAction._max.cawonce,
    ].filter((v): v is number => v !== null)

    const minSafeCawonce = candidates.length > 0
      ? Math.max(...candidates) + 1
      : null

    return { minSafeCawonce }
  } catch (err: any) {
    console.error('[/api/me] fetchCawonce error:', err.message)
    return { minSafeCawonce: null }
  }
}

async function fetchFailedRetries(tokenId: number) {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const entries = await prisma.txQueue.findMany({
      where: {
        senderId: tokenId,
        status: 'failed',
        reason: 'Cawonce already used',
      },
      select: {
        id: true,
        senderId: true,
        payload: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    })

    return entries
      .filter(e => e.updatedAt > cutoff)
      .map(e => ({
        id: e.id,
        senderId: e.senderId,
        payload: e.payload,
      }))
  } catch (err: any) {
    console.error('[/api/me] fetchFailedRetries error:', err.message)
    return []
  }
}

/**
 * GET /api/me/role
 * Highest role across the session's authorized tokens. Lightweight —
 * the FE polls this on app load to decide whether to surface the
 * Moderation entry in the sidebar / mount the ModeratorGate.
 *
 * Returns { role: 'USER' | 'MODERATOR' | 'ADMIN', actorTokenId: number | null }.
 * actorTokenId is the tokenId that holds the highest role (so the FE
 * can show a "moderating as @<username>" hint), or null when the
 * answer was 'USER'.
 *
 * BOOTSTRAP_ADMIN_TOKEN_IDS env var is honored here too — promotes
 * matching tokenIds to ADMIN even if their User row says USER.
 */
// Mirrors the resolution in middleware/auth.ts: explicit env list wins;
// VALIDATOR_ID is the default so a fresh install has the node operator
// as admin without any extra moderation env config.
const BOOTSTRAP_ADMIN_TOKEN_IDS = (() => {
  const explicit = (process.env.BOOTSTRAP_ADMIN_TOKEN_IDS ?? '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0)
  if (explicit.length > 0) return explicit
  const validatorId = Number(process.env.VALIDATOR_ID)
  return Number.isFinite(validatorId) && validatorId > 0 ? [validatorId] : []
})()

router.get('/role', async (req, res) => {
  try {
    await extractSession(req)
    if (!req.sessionData) {
      return res.json({ role: 'USER', actorTokenId: null })
    }
    const authorized = req.sessionData.authorizedTokenIds || []
    if (authorized.length === 0) {
      return res.json({ role: 'USER', actorTokenId: null })
    }

    const bootstrapHit = authorized.find(id => BOOTSTRAP_ADMIN_TOKEN_IDS.includes(id))
    if (bootstrapHit !== undefined) {
      return res.json({ role: 'ADMIN', actorTokenId: bootstrapHit })
    }

    // Pick the elevated tokenId with the highest rank. A single query
    // with two passes is fine; the row count is tiny.
    const elevated = await prisma.user.findMany({
      where: { tokenId: { in: authorized }, role: { in: ['MODERATOR', 'ADMIN'] } },
      select: { tokenId: true, role: true },
    })
    if (elevated.length === 0) {
      return res.json({ role: 'USER', actorTokenId: null })
    }
    const admin = elevated.find(u => u.role === 'ADMIN')
    if (admin) return res.json({ role: 'ADMIN', actorTokenId: admin.tokenId })
    const mod = elevated[0]
    return res.json({ role: 'MODERATOR', actorTokenId: mod.tokenId })
  } catch (err: any) {
    console.error('GET /api/me/role error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router

// src/api/routes/caws.ts
import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { shapeCaw, getCawIncludeConfig, handlePagination } from '../shared/cawUtils'
import { requireAuth } from '../middleware/auth'
import { getBlockedUserIds } from '../shared/blockUtils'

const router = Router()

/**
 * GET /api/caws
 * Query params:
 *   filter=following | liked | media | replies
 *   limit, cursor
 *   user=<username>
 *
 * Filter combinations:
 *   - filter=following: posts from users you follow
 *   - user=<username>: posts by that user (excluding replies and recaws)
 *   - user=<username>&filter=liked: posts liked by that user
 *   - user=<username>&filter=media: posts with images/videos by that user (including their recaws of media)
 *   - user=<username>&filter=replies: replies by that user
 */
router.get('/', async (req, res) => {
  try {
    const filter      = (req.query.filter as string|undefined)?.toLowerCase()
    const username    = req.query.user    as string|undefined
    const limit       = Math.min(parseInt(req.query.limit as string) || 20, 100)

    // Fix cursor handling - ignore invalid values like "undefined"
    const cursorParam = req.query.cursor as string | undefined
    const cursor = (cursorParam && cursorParam !== 'undefined' && cursorParam !== 'null')
      ? { id: Number(cursorParam) }
      : undefined
    const userIdHeader = req.header('x-user-id')
    const currentUserId = userIdHeader ? Number(userIdHeader) : undefined
    const blockedIds = currentUserId ? await getBlockedUserIds(currentUserId) : []

    // 1️⃣ if ?user=foo, look up that user
    let targetUserId: number|undefined
    if (username) {
      const user = await prisma.user.findUnique({
        where: { username }
      })
      if (!user) {
        // no such profile → empty feed
        return res.json({ items: [], nextCursor: undefined })
      }
      targetUserId = user.tokenId
    }

    // 2️⃣ build the `where` clause
    const where: any = {}

    // Build status visibility conditions
    const statusConditions = currentUserId
      ? [
          { status: 'SUCCESS' },
          {
            status: { in: ['PENDING', 'FAILED'] },
            userId: currentUserId
          }
        ]
      : { status: 'SUCCESS' }

    // Apply filter-specific conditions along with status visibility
    if (filter === 'following' && currentUserId) {
      // Express "posts by users I follow (or by me)" as a relation filter so
      // Postgres joins the Follow table internally. Previously we loaded the
      // full follow list into JS and passed it as an `IN (...)` clause — at 10k
      // follows that's ~150KB of SQL text and no index help from the join.
      // Relation names in schema.prisma are non-intuitive:
      //   User.follows = Follow[] @relation("Following")
      // where Follow.following is the "user being followed" side. So from a
      // candidate author's perspective, `user.follows.some(...)` means "author
      // appears in the Follow.following slot, and the corresponding follower
      // is currentUserId" — exactly "currentUser follows this author."
      const authorCondition = {
        OR: [
          { userId: currentUserId }, // always include own posts
          {
            user: {
              follows: {
                some: { followerId: currentUserId, action: 'FOLLOW' as const }
              }
            }
          }
        ]
      }

      if (Array.isArray(statusConditions)) {
        where.AND = [{ OR: statusConditions }, authorCondition]
      } else {
        where.AND = [statusConditions, authorCondition]
      }
    } else if (filter === 'liked' && targetUserId) {
      // "profile-likes" mode: caws this user has liked
      if (Array.isArray(statusConditions)) {
        where.AND = [
          { OR: statusConditions },
          { likes: { some: { userId: targetUserId } } }
        ]
      } else {
        where.AND = [
          statusConditions,
          { likes: { some: { userId: targetUserId } } }
        ]
      }
    } else if (filter === 'media' && targetUserId) {
      // "profile-media" mode: caws with images/videos from this user (including recaws)
      // Also detect posts containing image/gif URLs in content
      const mediaConditions = [
        { hasImage: true },
        { hasVideo: true },
        // Detect common image URL patterns in content
        { content: { contains: '.gif', mode: 'insensitive' as const } },
        { content: { contains: '.jpg', mode: 'insensitive' as const } },
        { content: { contains: '.jpeg', mode: 'insensitive' as const } },
        { content: { contains: '.png', mode: 'insensitive' as const } },
        { content: { contains: '.webp', mode: 'insensitive' as const } },
        { content: { contains: 'giphy.com', mode: 'insensitive' as const } },
        { content: { contains: 'imgur.com', mode: 'insensitive' as const } },
        { content: { contains: 'tenor.com', mode: 'insensitive' as const } },
      ]

      if (Array.isArray(statusConditions)) {
        where.AND = [
          { OR: statusConditions },
          {
            OR: [
              // Original posts by this user with media
              {
                userId: targetUserId,
                OR: mediaConditions
              },
              // Recaws by this user of posts with media
              {
                userId: targetUserId,
                action: 'RECAW',
                parent: {
                  OR: mediaConditions
                }
              }
            ]
          }
        ]
      } else {
        where.AND = [
          statusConditions,
          {
            OR: [
              // Original posts by this user with media
              {
                userId: targetUserId,
                OR: mediaConditions
              },
              // Recaws by this user of posts with media
              {
                userId: targetUserId,
                action: 'RECAW',
                parent: {
                  OR: mediaConditions
                }
              }
            ]
          }
        ]
      }
    } else if (filter === 'replies' && targetUserId) {
      // "profile-replies" mode: actual replies by this user (CAW with parent, not RECAW quotes)
      const repliesCondition = {
        userId: targetUserId,
        action: 'CAW',
        originalCawId: { not: null }
      }
      if (Array.isArray(statusConditions)) {
        where.AND = [
          { OR: statusConditions },
          repliesCondition
        ]
      } else {
        where.AND = [
          statusConditions,
          repliesCondition
        ]
      }
    } else if (targetUserId) {
      // "profile posts" mode: original posts, quotes, and recaws — excluding replies
      const postsCondition = {
        userId: targetUserId,
        OR: [
          { action: 'CAW', originalCawId: null },         // Original posts
          { action: 'RECAW' },                             // Recaws and quotes
        ]
      }
      if (Array.isArray(statusConditions)) {
        where.AND = [
          { OR: statusConditions },
          postsCondition
        ]
      } else {
        where.AND = [
          statusConditions,
          postsCondition
        ]
      }
    } else {
      // No filter - just apply status visibility
      if (Array.isArray(statusConditions)) {
        where.OR = statusConditions
      } else {
        Object.assign(where, statusConditions)
      }
    }

    // Filter out blocked users
    if (blockedIds.length > 0) {
      if (where.AND) {
        where.AND.push({ userId: { notIn: blockedIds } })
      } else {
        where.AND = [{ userId: { notIn: blockedIds } }]
        // Move existing OR/status into AND
        if (where.OR) {
          where.AND.unshift({ OR: where.OR })
          delete where.OR
        } else if (where.status) {
          where.AND.unshift({ status: where.status })
          delete where.status
        }
      }
    }

    // 3️⃣ fetch one extra for cursor‐based pagination
    const raws = await prisma.caw.findMany({
      where,
      orderBy: [
        { createdAt: 'desc' },
        { id:        'desc' },
      ],
      take:  limit + 1,
      skip:  cursor ? 1 : 0,
      cursor,
      include: getCawIncludeConfig({ currentUserId })
    })

    // 4️⃣ handle pagination and shape
    const { items: shapedCaws, nextCursor } = handlePagination(raws, limit, (caw) => caw.id)
    const items = shapedCaws.map(caw => shapeCaw(caw))



    return res.json({ items, nextCursor })
  } catch (err: any) {
    console.error('GET /api/caws error', err)
    return res.status(500).json({ error: 'Internal server error', items: [], nextCursor: undefined })
  }
})

/**
 * POST /api/caws/by-ids
 * Fetch multiple caws by their IDs (for bookmarks page)
 * Body: { ids: number[] }
 */
router.post('/by-ids', async (req, res) => {
  try {
    const { ids } = req.body as { ids: number[] }

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.json({ items: [] })
    }

    // Limit to prevent abuse
    const limitedIds = ids.slice(0, 100)

    const userIdHeader = req.header('x-user-id')
    const currentUserId = userIdHeader ? Number(userIdHeader) : undefined
    const blockedIds = currentUserId ? await getBlockedUserIds(currentUserId) : []

    const byIdsWhere: any = {
      id: { in: limitedIds },
      status: 'SUCCESS' // Only show successful caws
    }
    if (blockedIds.length > 0) {
      byIdsWhere.userId = { notIn: blockedIds }
    }

    const raws = await prisma.caw.findMany({
      where: byIdsWhere,
      include: getCawIncludeConfig({ currentUserId }),
      orderBy: { createdAt: 'desc' }
    })

    // Maintain the order from the input IDs
    const cawMap = new Map(raws.map(caw => [caw.id, caw]))
    const orderedCaws = limitedIds
      .map(id => cawMap.get(id))
      .filter(Boolean)
      .map(shapeCaw)

    return res.json({ items: orderedCaws })
  } catch (error) {
    console.error('POST /api/caws/by-ids error:', error)
    return res.status(500).json({ error: 'Failed to fetch caws' })
  }
})

// GET /api/caws/:id
router.get('/:id', async (req, res) => {
  const cawId = Number(req.params.id)
  // 1) fetch the caw itself
  const userIdHeader = req.header('x-user-id')
  const currentUserId = userIdHeader ? Number(userIdHeader) : undefined

  const raw = await prisma.caw.findUnique({
    where: { id: cawId },
    include: getCawIncludeConfig({ currentUserId })
  })

  if (!raw) return res.status(404).end()

  // Check if user is allowed to see this caw (PENDING/FAILED only visible to creator)
  if (raw.status !== 'SUCCESS' && raw.userId !== currentUserId) {
    return res.status(404).end()
  }

  // Aggregate tip data for this caw
  const tipAgg = await prisma.tip.aggregate({
    where: { cawId: cawId, pending: false },
    _count: true,
    _sum: { amount: true },
  })
  ;(raw as any).tipCount = tipAgg._count
  ;(raw as any).totalTipAmount = tipAgg._sum.amount || 0

  // 2) fetch comments (caws where originalCawId = cawId) with same visibility filter
  //    Exclude plain recaws (RECAW without text) — only show replies and quotes
  const commentBlockedIds = currentUserId ? await getBlockedUserIds(currentUserId) : []
  const commentWhere: any = {
    originalCawId: cawId,
    NOT: { action: 'RECAW', content: '' },
  }

  // Add status visibility filter for comments
  if (currentUserId) {
    commentWhere.OR = [
      { status: 'SUCCESS' },
      {
        status: { in: ['PENDING', 'FAILED'] },
        userId: currentUserId
      }
    ]
  } else {
    commentWhere.status = 'SUCCESS'
  }

  // Filter out comments from blocked users
  if (commentBlockedIds.length > 0) {
    const existingConditions: any[] = []
    if (commentWhere.OR) {
      existingConditions.push({ OR: commentWhere.OR })
      delete commentWhere.OR
    } else if (commentWhere.status) {
      existingConditions.push({ status: commentWhere.status })
      delete commentWhere.status
    }
    existingConditions.push({ userId: { notIn: commentBlockedIds } })
    commentWhere.AND = existingConditions
  }

  const commentLimit = Math.min(Number(req.query.commentLimit) || 20, 100)
  const commentCursor = req.query.commentCursor ? Number(req.query.commentCursor) : undefined

  const rawComments = await prisma.caw.findMany({
    where: commentWhere,
    take: commentLimit + 1,
    skip: commentCursor ? 1 : 0,
    cursor: commentCursor ? { id: commentCursor } : undefined,
    orderBy: [{ createdAt: 'asc' }, { cawonce: 'asc' }],
    include: getCawIncludeConfig({ currentUserId })
  })

  const hasMoreComments = rawComments.length > commentLimit
  if (hasMoreComments) rawComments.pop()
  const nextCommentCursor = hasMoreComments ? rawComments[rawComments.length - 1]?.id : undefined

  // Plain recaws (RECAW with no text) — rendered as inline 1-liners on the
  // post page, interleaved with replies by timestamp. Capped to keep the
  // payload small for popular posts.
  const rawRecaws = await prisma.caw.findMany({
    where: {
      originalCawId: cawId,
      action: 'RECAW',
      content: '',
      status: 'SUCCESS',
      ...(commentBlockedIds.length > 0 ? { userId: { notIn: commentBlockedIds } } : {}),
    },
    take: 100,
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      createdAt: true,
      user: { select: { tokenId: true, username: true, displayName: true, avatarUrl: true, image: true, defaultAvatarId: true } },
    },
  })
  const recaws = rawRecaws.map(r => ({
    id: r.id.toString(),
    timestamp: r.createdAt.toISOString(),
    user: r.user,
  }))

  // Tips on this caw — rendered inline like recaws. Same blocked-user filter
  // and cap. Pending tips are excluded so we don't show un-confirmed tips.
  const rawTips = await prisma.tip.findMany({
    where: {
      cawId,
      pending: false,
      ...(commentBlockedIds.length > 0 ? { senderId: { notIn: commentBlockedIds } } : {}),
    },
    take: 100,
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      amount: true,
      createdAt: true,
      sender: { select: { tokenId: true, username: true, displayName: true, avatarUrl: true, image: true, defaultAvatarId: true } },
    },
  })
  const tips = rawTips.map(t => ({
    id: t.id.toString(),
    timestamp: t.createdAt.toISOString(),
    amount: t.amount,
    user: t.sender,
  }))

  // shape into your CawItem shape…
  const shapedCaw = shapeCaw(raw)
  res.json({
    caw:     shapedCaw,
    comments: rawComments.map(shapeCaw),
    recaws,
    tips,
    hasMoreComments,
    nextCommentCursor,
  })
})


/**
 * POST /api/caws/:id/dismiss
 * Delete a FAILED caw so it no longer appears in the feed.
 */
router.post('/:id/dismiss', requireAuth({
  lookup: async (req) => {
    const caw = await prisma.caw.findUnique({ where: { id: parseInt(req.params.id) } })
    return caw?.userId
  }
}), async (req, res) => {
  const cawId = parseInt(req.params.id)
  if (isNaN(cawId)) return res.status(400).json({ error: 'Invalid caw ID' })

  try {
    const deleted = await prisma.caw.deleteMany({
      where: {
        id: cawId,
        status: 'FAILED'
      }
    })

    if (deleted.count === 0) {
      return res.status(404).json({ error: 'No failed caw found with that ID' })
    }

    res.json({ ok: true })
  } catch (err) {
    console.error('[API] Failed to dismiss caw:', err)
    res.status(500).json({ error: 'Failed to dismiss caw' })
  }
})

/**
 * DELETE /api/caws/:originalCawId/recaw
 * Undo a repost. Deletes the caller's RECAW of the specified caw.
 * Authenticated — only the recaw author can delete it.
 */
router.delete('/:originalCawId/recaw', requireAuth({
  lookup: async (req) => {
    // The caller must own the recaw, not the original caw.
    // We look up by originalCawId + session's authorized tokenIds.
    const originalCawId = parseInt(req.params.originalCawId)
    if (isNaN(originalCawId)) return undefined
    // Return any authorized tokenId — requireAuth will check that it matches
    // the x-user-id / session. We'll verify ownership in the handler.
    const userId = Number(req.header('x-user-id'))
    return isNaN(userId) ? undefined : userId
  }
}), async (req, res) => {
  const originalCawId = parseInt(req.params.originalCawId)
  const userId = Number(req.header('x-user-id'))
  if (isNaN(originalCawId) || isNaN(userId)) {
    return res.status(400).json({ error: 'Invalid parameters' })
  }

  try {
    // Look up the original caw to get its author + cawonce (needed for txqueue matching)
    const originalCaw = await prisma.caw.findUnique({
      where: { id: originalCawId },
      select: { userId: true, cawonce: true }
    })
    if (!originalCaw) {
      return res.status(404).json({ error: 'Original caw not found' })
    }

    // Find the user's recaw of this caw (confirmed or pending)
    const recaw = await prisma.caw.findFirst({
      where: { originalCawId, userId, action: 'RECAW' },
      select: { id: true, cawonce: true }
    })

    if (recaw) {
      // Delete the recaw, its txqueue entry, its action record,
      // and decrement the parent's recawCount.
      await prisma.$transaction([
        prisma.txQueue.deleteMany({
          where: { senderId: userId, payload: { path: ['data', 'cawonce'], equals: recaw.cawonce } }
        }),
        prisma.action.deleteMany({
          where: { senderId: userId, cawonce: recaw.cawonce }
        }),
        prisma.caw.delete({ where: { id: recaw.id } }),
        prisma.caw.update({
          where: { id: originalCawId },
          data: { recawCount: { decrement: 1 } }
        })
      ])
    } else {
      // No recaw row yet — might be a pending txqueue that hasn't been processed.
      // Match by actionType=3 (RECAW) + receiverId + receiverCawonce.
      const deleted = await prisma.txQueue.deleteMany({
        where: {
          senderId: userId,
          status: { in: ['pending', 'failed'] },
          AND: [
            { payload: { path: ['data', 'actionType'], equals: 3 } },
            { payload: { path: ['data', 'receiverId'], equals: originalCaw.userId } },
            { payload: { path: ['data', 'receiverCawonce'], equals: originalCaw.cawonce } },
          ]
        }
      })
      // Also delete the pending Caw row if one was created optimistically
      await prisma.caw.deleteMany({
        where: { originalCawId, userId, action: 'RECAW', status: 'PENDING' }
      })
      if (deleted.count === 0) {
        return res.status(404).json({ error: 'Recaw not found' })
      }
    }

    res.json({ ok: true })
  } catch (err: any) {
    console.error('[API] Failed to undo recaw:', err?.message || err)
    res.status(500).json({ error: 'Failed to undo repost' })
  }
})

/**
 * GET /api/caws/verify/:userId/:cawonce
 * Returns the EIP-712 signature and action data for a post, enabling client-side verification.
 * The frontend can recover the signer from the signature and verify it matches the post author.
 */
router.get('/verify/:userId/:cawonce', async (req, res) => {
  try {
    const userId = Number(req.params.userId)
    const cawonce = Number(req.params.cawonce)

    if (isNaN(userId) || isNaN(cawonce)) {
      return res.status(400).json({ error: 'Invalid userId or cawonce' })
    }

    // Find the TxQueue entry which has the signature
    const txEntry = await prisma.txQueue.findFirst({
      where: {
        senderId: userId,
        status: 'done',
        payload: {
          path: ['data', 'cawonce'],
          equals: cawonce,
        }
      },
      orderBy: { createdAt: 'desc' },
    })

    if (!txEntry) {
      return res.json({ verified: false, reason: 'No transaction record found' })
    }

    const payload = txEntry.payload as any

    return res.json({
      verified: true,
      signature: txEntry.signedTx,
      data: payload.data,
      domain: payload.domain,
      types: payload.types,
    })
  } catch (error) {
    console.error('GET /api/caws/verify error:', error)
    return res.status(500).json({ error: 'Verification lookup failed' })
  }
})

export default router


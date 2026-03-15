// src/api/routes/caws.ts
import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { shapeCaw, getCawIncludeConfig, handlePagination } from '../shared/cawUtils'
import { mockCawItems, userMockItems } from '../shared/mockData'

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
    
    console.log('API Debug - username parameter:', username)
    
    // Fix cursor handling - ignore invalid values like "undefined"
    const cursorParam = req.query.cursor as string | undefined
    const cursor = (cursorParam && cursorParam !== 'undefined' && cursorParam !== 'null')
      ? { id: Number(cursorParam) }
      : undefined
    const userIdHeader = req.header('x-user-id')
    const currentUserId = userIdHeader ? Number(userIdHeader) : undefined

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
      const follows = await prisma.follow.findMany({
        where: { followerId: currentUserId, action: 'FOLLOW' },
        select: { followingId: true }
      })
      // Include self in following feed (users should see their own posts)
      const followingIds = follows.map(f => f.followingId)
      followingIds.push(currentUserId) // Add self

      // Combine status visibility with following filter using AND
      if (Array.isArray(statusConditions)) {
        where.AND = [
          { OR: statusConditions },
          { userId: { in: followingIds } }
        ]
      } else {
        where.AND = [
          statusConditions,
          { userId: { in: followingIds } }
        ]
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
      // "profile-replies" mode: caws that are replies by this user
      if (Array.isArray(statusConditions)) {
        where.AND = [
          { OR: statusConditions },
          {
            userId: targetUserId,
            originalCawId: { not: null }
          }
        ]
      } else {
        where.AND = [
          statusConditions,
          {
            userId: targetUserId,
            originalCawId: { not: null }
          }
        ]
      }
    } else if (targetUserId) {
      // "profile posts" mode: caws they created (excluding replies and recaws)
      if (Array.isArray(statusConditions)) {
        where.AND = [
          { OR: statusConditions },
          {
            userId: targetUserId,
            action: 'CAW',
            originalCawId: null  // Exclude replies
          }
        ]
      } else {
        where.AND = [
          statusConditions,
          {
            userId: targetUserId,
            action: 'CAW',
            originalCawId: null  // Exclude replies
          }
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

    const raws = await prisma.caw.findMany({
      where: {
        id: { in: limitedIds },
        status: 'SUCCESS' // Only show successful caws
      },
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

  console.log(`[API /caws/${cawId}] currentUserId:`, currentUserId)

  const raw = await prisma.caw.findUnique({
    where: { id: cawId },
    include: getCawIncludeConfig({ currentUserId })
  })

  // Debug: Log the raw recaws data
  console.log(`[API /caws/${cawId}] raw.recaws:`, raw?.recaws)
  console.log(`[API /caws/${cawId}] raw.recawCount:`, raw?.recawCount)

  // Also check if there are ANY recaws for this caw
  const allRecaws = await prisma.caw.findMany({
    where: { originalCawId: cawId, action: 'RECAW' },
    select: { id: true, userId: true, status: true }
  })
  console.log(`[API /caws/${cawId}] All recaws for this caw:`, allRecaws)

  if (!raw) return res.status(404).end()

  // Check if user is allowed to see this caw (PENDING/FAILED only visible to creator)
  if (raw.status !== 'SUCCESS' && raw.userId !== currentUserId) {
    return res.status(404).end()
  }

  // 2) fetch comments (caws where originalCawId = cawId) with same visibility filter
  const commentWhere: any = { originalCawId: cawId }

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

  const rawComments = await prisma.caw.findMany({
    where: commentWhere,
    orderBy: { createdAt: 'asc' },
    include: getCawIncludeConfig({ currentUserId })
  })

  // shape into your CawItem shape…
  const shapedCaw = shapeCaw(raw)
  console.log(`[API /caws/${cawId}] Sending response:`, {
    hasRecawed: shapedCaw.hasRecawed,
    recawPending: shapedCaw.recawPending,
    recawCount: shapedCaw.recawCount
  })
  res.json({
    caw:     shapedCaw,
    comments: rawComments.map(shapeCaw)
  })
})


/**
 * POST /api/caws/:id/dismiss
 * Delete a FAILED caw so it no longer appears in the feed.
 */
router.post('/:id/dismiss', async (req, res) => {
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

export default router


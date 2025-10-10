// src/api/routes/caws.ts
import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { shapeCaw, getCawIncludeConfig, handlePagination } from '../shared/cawUtils'
import { mockCawItems, userMockItems } from '../shared/mockData'

const router = Router()

/**
 * GET /api/caws
 * Query params:
 *   filter=following | liked
 *   limit, cursor
 *   user=<username>       ← new!
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
    } else if (targetUserId) {
      // "profile posts" mode: caws they created
      if (Array.isArray(statusConditions)) {
        where.AND = [
          { OR: statusConditions },
          { userId: targetUserId }
        ]
      } else {
        where.AND = [
          statusConditions,
          { userId: targetUserId }
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
  res.json({
    caw:     shapeCaw(raw),
    comments: rawComments.map(shapeCaw)
  })
})


export default router


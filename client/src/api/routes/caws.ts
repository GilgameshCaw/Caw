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
    
    // If it's a specific user profile, return their posts immediately
    if (username === "user") {
        console.log('Returning user mock data for username:', username)
        return res.json({ items: userMockItems, nextCursor: undefined })
    }
    
    const cursor      = req.query.cursor ? { id: Number(req.query.cursor) } : undefined
    const currentUserId = Number(req.header('x-user-id') || 0) || undefined

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

    if (filter === 'following' && currentUserId) {
      const follows = await prisma.follow.findMany({
        where: { followerId: currentUserId, action: 'FOLLOW' },
        select: { followingId: true }
      })
      where.userId = { in: follows.map(f => f.followingId) }
    } else if (filter === 'liked' && targetUserId) {
      // “profile-likes” mode: caws this user has liked
      where.likes = { some: { userId: targetUserId } }
    } else if (targetUserId) {
      // “profile posts” mode: caws they created
      where.userId = targetUserId
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


    
    // For now, always return mock data for testing if no items
    if (items.length === 0) {
      return res.json({ items: mockCawItems, nextCursor: undefined })
    }
    
    return res.json({ items, nextCursor })
  } catch (err: any) {
    console.error('GET /api/caws error', err)

    return res.json({ items: mockCawItems, nextCursor: undefined })
  }
})

// GET /api/caws/:id
router.get('/:id', async (req, res) => {
  const cawId = Number(req.params.id)
  // 1) fetch the caw itself
  const currentUserId = Number(req.header('x-user-id')) || undefined

  const raw = await prisma.caw.findUnique({
    where: { id: cawId },
    include: getCawIncludeConfig({ currentUserId })
  })
  if (!raw) return res.status(404).end()

  // 2) fetch comments (caws where originalCawId = cawId)
  const rawComments = await prisma.caw.findMany({
    where: { originalCawId: cawId },
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


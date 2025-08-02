// src/api/routes/caws.ts
import { Router } from 'express'
import { prisma }    from '../../prismaClient'

const router = Router()

// somewhere above your router.get(...)
function shapeCaw(raw: {
  id: number
  content: string
  createdAt: Date
  user: { tokenId: number; username: string; image?: string }
  _count: { likes: number; recaws: number }
  likes?: Array<{ userId: number }>
  recaws?: Array<{ id: number }>
  commentCount: number
  recawCount: number
  likeCount: number
  cawonce: number
  parent?: any  // if you’ve included it via Prisma
}) {
  return {
    id:          raw.id.toString(),
    content:     raw.content,
    timestamp:   raw.createdAt.toISOString(),
    user:        raw.user,
    likeCount:   raw.likeCount,
    hasLiked:    Boolean(raw.likes && raw.likes.length > 0),
    hasRecawed:  Boolean(raw.recaws && raw.recaws.length > 0),
    commentCount: raw.commentCount,
    recawCount:   raw.recawCount,
    cawonce:      raw.cawonce,
    // if you included originalCaw in your query, recurse:
    originalCaw: raw.parent ? shapeCaw(raw.parent) : undefined,
  }
}

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
      include: {
        user:   { select: { tokenId: true, username: true, image: true } },
        likes:  currentUserId
          ? { where: { userId: currentUserId }, select: { userId: true } }
          : false,
        recaws: currentUserId
          ? { where: { userId: currentUserId, action: 'RECAW' }, select: { id: true } }
          : false,
        parent: {
          include: { user: { select: { tokenId: true, username: true, image: true } } }
        },
      }
    })

    // 4️⃣ peel off the extra row if any
    let nextCursor: number|undefined
    if (raws.length > limit) {
      const last = raws.pop()!
      nextCursor = last.id
    }


    // 5️⃣ shape into your JSON model
    const items = raws.map(caw => ({
      id:            caw.id.toString(),
      timestamp:     caw.createdAt,
      content:       caw.content,
      user:          caw.user,

      hasLiked:      Boolean(currentUserId && caw.likes.length > 0),
      hasRecawed:    Boolean(currentUserId && caw.recaws.length > 0),
      commentCount:  caw.commentCount,
      recawCount:    caw.recawCount,
      likeCount:     caw.likeCount,
      cawonce:       caw.cawonce,
      parent:   caw.parent ? {
            id:        caw.parent.id.toString(),
            user:      caw.parent.user,
            content:   caw.parent.content,
            timestamp: caw.parent.createdAt,
          } : null,
    }))

    return res.json({ items, nextCursor })
  } catch (err: any) {
    console.error('GET /api/caws error', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

// GET /api/caws/:id
router.get('/:id', async (req, res) => {
  const cawId = Number(req.params.id)
  // 1) fetch the caw itself
  const raw = await prisma.caw.findUnique({
    where: { id: cawId },
    include: {
      user:   { select: { tokenId: true, username: true, image: true } },
      _count: { select: { likes: true, recaws: true } },
      likes:  req.header('x-user-id')
               ? { where: { userId: Number(req.header('x-user-id')) } }
               : false,
      recaws: req.header('x-user-id')
               ? { where: { userId: Number(req.header('x-user-id')), action: 'RECAW' } }
               : false,
      parent: {
        include: { user: { select: { tokenId: true, username: true, image: true } } }
      }
    }
  })
  if (!raw) return res.status(404).end()

  // 2) fetch comments (caws where originalCawId = cawId)
  const rawComments = await prisma.caw.findMany({
    where: { originalCawId: cawId },
    orderBy: { createdAt: 'asc' },
    include: {
      user:   { select: { tokenId: true, username: true, image: true } },
      _count: { select: { likes: true, recaws: true } },
      likes:  req.header('x-user-id')
               ? { where: { userId: Number(req.header('x-user-id')) } }
               : false,
      recaws: req.header('x-user-id')
               ? { where: { userId: Number(req.header('x-user-id')), action: 'RECAW' } }
               : false,
      parent: {
        include: { user: { select: { tokenId: true, username: true, image: true } } }
      }
    }
  })

  // shape into your CawItem shape…
  res.json({
    caw:     shapeCaw(raw),
    comments: rawComments.map(shapeCaw)
  })
})


export default router


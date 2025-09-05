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
    
    console.log('API Debug - username parameter:', username)
    
    // If it's a specific user profile, return their posts immediately
    if (username === "user") {
        console.log('Returning user mock data for username:', username)
        const userMockItems = [
          {
            id: "user1",
            timestamp: new Date().toISOString(),
            content: "Just exploring the Caw Protocol ecosystem! The decentralized social media revolution is here 🚀",
            user: { tokenId: 1, username: "user", image: "https://example.com/user-avatar.jpg" },
            hasLiked: false,
            hasRecawed: false,
            commentCount: 5,
            recawCount: 12,
            likeCount: 24,
            cawonce: 1,
            parent: null,
          },
          {
            id: "user2", 
            timestamp: new Date(Date.now() - 1800000).toISOString(),
            content: "The community here is amazing! Everyone is so supportive and the technology is mind-blowing 💙 #CawProtocol #Community",
            user: { tokenId: 1, username: "user", image: "https://example.com/user-avatar.jpg" },
            hasLiked: false,
            hasRecawed: false,
            commentCount: 8,
            recawCount: 15,
            likeCount: 31,
            cawonce: 2,
            parent: null,
          },
          {
            id: "user3",
            timestamp: new Date(Date.now() - 3600000).toISOString(), 
            content: "Minting usernames on Caw Protocol is so smooth! The gas fees are reasonable and the process is intuitive ✨",
            user: { tokenId: 1, username: "user", image: "https://example.com/user-avatar.jpg" },
            hasLiked: false,
            hasRecawed: false,
            commentCount: 3,
            recawCount: 7,
            likeCount: 18,
            cawonce: 3,
            parent: null,
          },
          {
            id: "user4",
            timestamp: new Date(Date.now() - 5400000).toISOString(),
            content: "Staking CAW tokens and earning rewards while supporting the network! This is the future of social media 🎯",
            user: { tokenId: 1, username: "user", image: "https://example.com/user-avatar.jpg" },
            hasLiked: false,
            hasRecawed: false,
            commentCount: 6,
            recawCount: 9,
            likeCount: 22,
            cawonce: 4,
            parent: null,
          },
          {
            id: "user5",
            timestamp: new Date(Date.now() - 7200000).toISOString(),
            content: "The decentralized approach to social media is exactly what we needed. No more centralized control! 🌐 #DecentralizedFreedom",
            user: { tokenId: 1, username: "user", image: "https://example.com/user-avatar.jpg" },
            hasLiked: false,
            hasRecawed: false,
            commentCount: 4,
            recawCount: 11,
            likeCount: 27,
            cawonce: 5,
            parent: null,
          }
        ]
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


    
    // For now, always return mock data for testing if no items
    if (items.length === 0) {
      // Default mock data for other cases - Same as Bookmarks
      const mockItems = [
        {
          id: "1",
          timestamp: new Date().toISOString(),
          content: "Just discovered the amazing potential of decentralized social media! The future is here and it's built on blockchain technology. #CawProtocol #Web3",
          user: { tokenId: 1, username: "cawuser1", image: "https://example.com/avatar.jpg" },
          hasLiked: true,
          hasRecawed: false,
          commentCount: 8,
          recawCount: 12,
          likeCount: 24,
          cawonce: 1,
          parent: null,
        },
        {
          id: "2", 
          timestamp: new Date(Date.now() - 14400000).toISOString(),
          content: "Building the next generation of social platforms with Caw Protocol. The community-driven approach is revolutionary!",
          user: { tokenId: 2, username: "blockchaindev", image: "https://example.com/avatar2.jpg" },
          hasLiked: false,
          hasRecawed: false,
          commentCount: 23,
          recawCount: 45,
          likeCount: 156,
          cawonce: 2,
          parent: null,
        },
        {
          id: "3",
          timestamp: new Date(Date.now() - 21600000).toISOString(), 
          content: "The staking rewards on Caw Protocol are incredible! Earning while participating in the ecosystem. This is how social media should work.",
          user: { tokenId: 3, username: "cryptoenthusiast", image: "https://example.com/avatar3.jpg" },
          hasLiked: false,
          hasRecawed: false,
          commentCount: 15,
          recawCount: 28,
          likeCount: 89,
          cawonce: 3,
          parent: null,
        },
        {
          id: "4",
          timestamp: new Date(Date.now() - 28800000).toISOString(),
          content: "The decentralized approach to social media is exactly what we needed. No more centralized control! 🌐 #DecentralizedFreedom",
          user: { tokenId: 4, username: "web3builder", image: "https://example.com/avatar4.jpg" },
          hasLiked: false,
          hasRecawed: false,
          commentCount: 12,
          recawCount: 19,
          likeCount: 67,
          cawonce: 4,
          parent: null,
        },
        {
          id: "5",
          timestamp: new Date(Date.now() - 36000000).toISOString(),
          content: "The community here is amazing! Everyone is so supportive and the technology is mind-blowing 💙 #CawProtocol #Community",
          user: { tokenId: 5, username: "cawcommunity", image: "https://example.com/avatar5.jpg" },
          hasLiked: false,
          hasRecawed: false,
          commentCount: 6,
          recawCount: 14,
          likeCount: 43,
          cawonce: 5,
          parent: null,
        },
        {
          id: "6",
          timestamp: new Date(Date.now() - 43200000).toISOString(),
          content: "Staking CAW tokens and earning rewards while supporting the network! This is the future of social media 🎯",
          user: { tokenId: 6, username: "decentralized", image: "https://example.com/avatar6.jpg" },
          hasLiked: false,
          hasRecawed: false,
          commentCount: 9,
          recawCount: 22,
          likeCount: 78,
          cawonce: 6,
          parent: null,
        }
      ]
      return res.json({ items: mockItems, nextCursor: undefined })
    }
    
    return res.json({ items, nextCursor })
  } catch (err: any) {
    console.error('GET /api/caws error', err)
    
    // Return mock data when database fails - Same as Bookmarks
    const mockItems = [
      {
        id: "1",
        timestamp: new Date().toISOString(),
        content: "Just discovered the amazing potential of decentralized social media! The future is here and it's built on blockchain technology. #CawProtocol #Web3",
        user: { tokenId: 1, username: "cawuser1", image: "https://example.com/avatar.jpg" },
        hasLiked: true,
        hasRecawed: false,
        commentCount: 8,
        recawCount: 12,
        likeCount: 24,
        cawonce: 1,
        parent: null,
      },
      {
        id: "2", 
        timestamp: new Date(Date.now() - 14400000).toISOString(),
        content: "Building the next generation of social platforms with Caw Protocol. The community-driven approach is revolutionary!",
        user: { tokenId: 2, username: "blockchaindev", image: "https://example.com/avatar2.jpg" },
        hasLiked: false,
        hasRecawed: false,
        commentCount: 23,
        recawCount: 45,
        likeCount: 156,
        cawonce: 2,
        parent: null,
      },
      {
        id: "3",
        timestamp: new Date(Date.now() - 21600000).toISOString(), 
        content: "The staking rewards on Caw Protocol are incredible! Earning while participating in the ecosystem. This is how social media should work.",
        user: { tokenId: 3, username: "cryptoenthusiast", image: "https://example.com/avatar3.jpg" },
        hasLiked: false,
        hasRecawed: false,
        commentCount: 15,
        recawCount: 28,
        likeCount: 89,
        cawonce: 3,
        parent: null,
      },
      {
        id: "4",
        timestamp: new Date(Date.now() - 28800000).toISOString(),
        content: "The decentralized approach to social media is exactly what we needed. No more centralized control! 🌐 #DecentralizedFreedom",
        user: { tokenId: 4, username: "web3builder", image: "https://example.com/avatar4.jpg" },
        hasLiked: false,
        hasRecawed: false,
        commentCount: 12,
        recawCount: 19,
        likeCount: 67,
        cawonce: 4,
        parent: null,
      },
      {
        id: "5",
        timestamp: new Date(Date.now() - 36000000).toISOString(),
        content: "The community here is amazing! Everyone is so supportive and the technology is mind-blowing 💙 #CawProtocol #Community",
        user: { tokenId: 5, username: "cawcommunity", image: "https://example.com/avatar5.jpg" },
        hasLiked: false,
        hasRecawed: false,
        commentCount: 6,
        recawCount: 14,
        likeCount: 43,
        cawonce: 5,
        parent: null,
      },
      {
        id: "6",
        timestamp: new Date(Date.now() - 43200000).toISOString(),
        content: "Staking CAW tokens and earning rewards while supporting the network! This is the future of social media 🎯",
        user: { tokenId: 6, username: "decentralized", image: "https://example.com/avatar6.jpg" },
        hasLiked: false,
        hasRecawed: false,
        commentCount: 9,
        recawCount: 22,
        likeCount: 78,
        cawonce: 6,
        parent: null,
      }
    ]
    
    return res.json({ items: mockItems, nextCursor: undefined })
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


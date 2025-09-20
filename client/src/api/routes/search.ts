import { Router } from 'express'
import { PrismaClient } from '@prisma/client'

const router = Router()
const prisma = new PrismaClient()

/**
 * GET /api/search
 * Search for caws, users, and hashtags
 */
router.get('/', async (req, res) => {
  try {
    const { q, type = 'all', limit = 20, offset = 0 } = req.query

    if (!q || typeof q !== 'string' || q.trim().length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' })
    }

    const query = q.trim()
    const searchLimit = Math.min(Number(limit), 50)
    const searchOffset = Number(offset)

    const results: any = {
      caws: [],
      users: [],
      hashtags: []
    }

    // Search caws if type is 'all' or 'caws'
    if (type === 'all' || type === 'caws') {
      const caws = await prisma.$queryRaw`
        SELECT c.*, u.*,
          ts_rank(to_tsvector('english', c.text), plainto_tsquery('english', ${query})) as rank
        FROM "Caw" c
        LEFT JOIN "User" u ON c."userId" = u.id
        WHERE to_tsvector('english', c.text) @@ plainto_tsquery('english', ${query})
        ORDER BY rank DESC, c."createdAt" DESC
        LIMIT ${searchLimit}
        OFFSET ${searchOffset}
      `
      results.caws = caws
    }

    // Search users if type is 'all' or 'users'
    if (type === 'all' || type === 'users') {
      const users = await prisma.user.findMany({
        where: {
          OR: [
            { username: { contains: query, mode: 'insensitive' } },
            { displayName: { contains: query, mode: 'insensitive' } }
          ]
        },
        take: searchLimit,
        skip: searchOffset,
        orderBy: [
          { followerCount: 'desc' },
          { createdAt: 'desc' }
        ]
      })
      results.users = users
    }

    // Search hashtags if type is 'all' or 'hashtags'
    if (type === 'all' || type === 'hashtags') {
      const hashtags = await prisma.hashtag.findMany({
        where: {
          tag: { contains: query.replace('#', ''), mode: 'insensitive' }
        },
        take: searchLimit,
        skip: searchOffset,
        orderBy: { usageCount: 'desc' },
        select: {
          tag: true,
          usageCount: true
        }
      })
      results.hashtags = hashtags
    }

    return res.json(results)

  } catch (error) {
    console.error('GET /api/search error:', error)
    return res.status(500).json({ error: 'Search failed' })
  }
})

/**
 * GET /api/search/suggestions
 * Get search suggestions based on partial input
 */
router.get('/suggestions', async (req, res) => {
  try {
    const { q } = req.query

    if (!q || typeof q !== 'string' || q.trim().length < 1) {
      return res.json({ suggestions: [] })
    }

    const query = q.trim()
    const suggestions: any[] = []

    // Get user suggestions
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { username: { startsWith: query, mode: 'insensitive' } },
          { displayName: { startsWith: query, mode: 'insensitive' } }
        ]
      },
      take: 5,
      orderBy: { followerCount: 'desc' },
      select: {
        username: true,
        displayName: true,
        avatar: true,
        verified: true
      }
    })

    users.forEach(user => {
      suggestions.push({
        type: 'user',
        value: user.username,
        display: user.displayName || user.username,
        avatar: user.avatar,
        verified: user.verified
      })
    })

    // Get hashtag suggestions if query starts with #
    if (query.startsWith('#')) {
      const hashtagQuery = query.substring(1)
      const hashtags = await prisma.hashtag.findMany({
        where: {
          tag: { startsWith: hashtagQuery, mode: 'insensitive' }
        },
        take: 5,
        orderBy: { usageCount: 'desc' },
        select: {
          tag: true,
          usageCount: true
        }
      })

      hashtags.forEach(hashtag => {
        suggestions.push({
          type: 'hashtag',
          value: `#${hashtag.tag}`,
          display: `#${hashtag.tag}`,
          count: hashtag.usageCount
        })
      })
    }

    return res.json({ suggestions })

  } catch (error) {
    console.error('GET /api/search/suggestions error:', error)
    return res.json({ suggestions: [] })
  }
})

/**
 * GET /api/search/trending
 * Get trending searches
 */
router.get('/trending', async (req, res) => {
  try {
    // Get trending hashtags
    const trendingHashtags = await prisma.hashtag.findMany({
      take: 10,
      orderBy: [
        { recentUsageCount: 'desc' },
        { usageCount: 'desc' }
      ],
      select: {
        tag: true,
        usageCount: true,
        recentUsageCount: true
      }
    })

    // Get trending users (most followed recently)
    const trendingUsers = await prisma.user.findMany({
      take: 5,
      orderBy: { followerCount: 'desc' },
      where: {
        createdAt: {
          gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Last 7 days
        }
      },
      select: {
        username: true,
        displayName: true,
        avatar: true,
        verified: true,
        followerCount: true
      }
    })

    return res.json({
      hashtags: trendingHashtags,
      users: trendingUsers
    })

  } catch (error) {
    console.error('GET /api/search/trending error:', error)
    return res.status(500).json({ error: 'Failed to get trending' })
  }
})

export default router
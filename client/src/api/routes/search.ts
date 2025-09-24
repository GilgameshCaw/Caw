import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { elasticsearchService } from '../../services/ElasticsearchService'

const router = Router()

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
      // Limit to 10 caws for 'all' tab, use full limit for 'caws' tab
      const cawLimit = type === 'all' ? 10 : searchLimit
      const caws = await prisma.caw.findMany({
        where: {
          content: { contains: query, mode: 'insensitive' }
        },
        take: cawLimit + 1, // Take one more to check if there are more results
        skip: type === 'all' ? 0 : searchOffset, // No pagination for 'all' tab
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { tokenId: true, username: true, image: true } }
        }
      })

      // Check if there are more results
      const hasMore = caws.length > cawLimit
      const items = hasMore ? caws.slice(0, cawLimit) : caws

      // Format caws similar to the feed response format
      const formattedCaws = items.map((caw: any) => ({
        id: caw.id.toString(),
        content: caw.content,
        timestamp: caw.createdAt.toISOString(),
        user: {
          id: caw.user.tokenId,
          tokenId: caw.user.tokenId,
          username: caw.user.username,
          image: caw.user.image
        },
        parent: caw.originalCawId || null,
        likeCount: 0,
        viewCount: 0,
        hasLiked: false, // This would need user context
        hasRecawed: false, // This would need user context
        commentCount: 0,
        recawCount: 0,
        cawonce: caw.cawonce,
        imageData: caw.imageData,
        imageUrl: null,
        hasImage: caw.hasImage,
        videoData: caw.videoData,
        hasVideo: caw.hasVideo,
        pending: caw.pending || false
      }))

      results.caws = formattedCaws

      // If searching for caws only, return in Feed format
      if (type === 'caws') {
        return res.json({
          items: formattedCaws,
          nextCursor: hasMore ? searchOffset + searchLimit : undefined
        })
      }
    }

    // Search users if type is 'all' or 'users'
    if (type === 'all' || type === 'users') {
      // Limit to 5 users for 'all' tab, use full limit for 'users' tab
      const userLimit = type === 'all' ? 5 : searchLimit
      const users = await prisma.user.findMany({
        where: {
          username: { contains: query, mode: 'insensitive' }
        },
        take: userLimit,
        skip: type === 'all' ? 0 : searchOffset, // No pagination for 'all' tab
        orderBy: [
          { followerCount: 'desc' },
          { createdAt: 'desc' }
        ]
      })
      results.users = users
    }

    // Search hashtags
    if (type === 'all' || type === 'hashtags') {
      // Limit to 5 hashtags for 'all' tab, use full limit for 'hashtags' tab
      const hashtagLimit = type === 'all' ? 5 : searchLimit
      const hashtags = await prisma.hashtag.findMany({
        where: {
          name: { contains: query.replace('#', ''), mode: 'insensitive' }
        },
        take: hashtagLimit,
        skip: type === 'all' ? 0 : searchOffset, // No pagination for 'all' tab
        orderBy: { usageCount: 'desc' },
        select: {
          name: true,
          usageCount: true
        }
      })
      results.hashtags = hashtags.map(h => ({ tag: h.name, usageCount: h.usageCount }))
    }

    // Add hasMore flags for 'all' tab to show "View more" links
    if (type === 'all') {
      const response: any = { ...results }
      // Check if there are more results than what we're showing
      if (results.caws.length === 10) response.hasMoreCaws = true
      if (results.users.length === 5) response.hasMoreUsers = true
      if (results.hashtags.length === 5) response.hasMoreHashtags = true
      return res.json(response)
    }

    return res.json(results)

  } catch (error: any) {
    console.error('GET /api/search error:', error)
    console.error('Error message:', error.message)
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
        username: { startsWith: query, mode: 'insensitive' }
      },
      take: 5,
      orderBy: { followerCount: 'desc' },
      select: {
        username: true,
        image: true
      }
    })

    users.forEach(user => {
      suggestions.push({
        type: 'user',
        value: user.username,
        display: user.username,
        avatar: user.image
      })
    })

    // Get hashtag suggestions if query starts with #
    if (query.startsWith('#')) {
      const hashtagQuery = query.substring(1)
      const hashtags = await prisma.hashtag.findMany({
        where: {
          name: { startsWith: hashtagQuery, mode: 'insensitive' }
        },
        take: 5,
        orderBy: { usageCount: 'desc' },
        select: {
          name: true,
          usageCount: true
        }
      })

      hashtags.forEach(hashtag => {
        suggestions.push({
          type: 'hashtag',
          value: `#${hashtag.name}`,
          display: `#${hashtag.name}`,
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
      orderBy: { usageCount: 'desc' },
      select: {
        name: true,
        usageCount: true
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
        image: true,
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
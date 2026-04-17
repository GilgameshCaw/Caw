import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { elasticsearchService } from '../../services/ElasticsearchService'
import { getBlockedUserIds } from '../shared/blockUtils'
import { requireAdmin } from '../middleware/auth'

const router = Router()

/**
 * Search caws using Prisma (PostgreSQL fallback)
 */
async function searchCawsWithPrisma(query: string, limit: number, offset: number) {
  const caws = await prisma.caw.findMany({
    where: {
      content: { contains: query, mode: 'insensitive' },
      status: 'SUCCESS'
    },
    take: limit + 1,
    skip: offset,
    orderBy: { createdAt: 'desc' },
    include: {
      user: { select: { tokenId: true, username: true, image: true } },
      parent: {
        select: {
          id: true,
          user: { select: { tokenId: true, username: true, image: true } }
        }
      }
    }
  })

  const hasMore = caws.length > limit
  const items = hasMore ? caws.slice(0, limit) : caws

  return {
    items: items.map((caw: any) => ({
      id: caw.id.toString(),
      content: caw.content,
      timestamp: caw.createdAt.toISOString(),
      user: {
        id: caw.user.tokenId,
        tokenId: caw.user.tokenId,
        username: caw.user.username,
        image: caw.user.image
      },
      parent: caw.parent ? {
        id: caw.parent.id.toString(),
        user: {
          id: caw.parent.user.tokenId,
          tokenId: caw.parent.user.tokenId,
          username: caw.parent.user.username,
          image: caw.parent.user.image
        }
      } : null,
      likeCount: caw.likeCount || 0,
      viewCount: caw.viewCount || 0,
      hasLiked: false,
      hasRecawed: false,
      commentCount: caw.commentCount || 0,
      recawCount: caw.recawCount || 0,
      cawonce: caw.cawonce,
      imageData: caw.imageData,
      imageUrl: null,
      hasImage: caw.hasImage,
      videoData: caw.videoData,
      hasVideo: caw.hasVideo,
      pending: false
    })),
    hasMore
  }
}

/**
 * Search caws using Elasticsearch
 */
async function searchCawsWithES(query: string, limit: number, offset: number) {
  const response = await elasticsearchService.search(query, 'caws', limit + 1, offset)
  if (!response?.hits?.hits) return null

  const hits = response.hits.hits
  const hasMore = hits.length > limit
  const items = hasMore ? hits.slice(0, limit) : hits

  // Get full caw data from database for the matched IDs
  const cawIds = items.map((hit: any) => parseInt(hit._id))
  if (cawIds.length === 0) return { items: [], hasMore: false }

  const caws = await prisma.caw.findMany({
    where: { id: { in: cawIds }, status: 'SUCCESS' },
    include: {
      user: { select: { tokenId: true, username: true, image: true } },
      parent: {
        select: {
          id: true,
          user: { select: { tokenId: true, username: true, image: true } }
        }
      }
    }
  })

  // Maintain ES relevance order
  const cawMap = new Map(caws.map(c => [c.id, c]))
  const orderedCaws = cawIds.map((id: number) => cawMap.get(id)).filter(Boolean)

  return {
    items: orderedCaws.map((caw: any) => ({
      id: caw.id.toString(),
      content: caw.content,
      timestamp: caw.createdAt.toISOString(),
      user: {
        id: caw.user.tokenId,
        tokenId: caw.user.tokenId,
        username: caw.user.username,
        image: caw.user.image
      },
      parent: caw.parent ? {
        id: caw.parent.id.toString(),
        user: {
          id: caw.parent.user.tokenId,
          tokenId: caw.parent.user.tokenId,
          username: caw.parent.user.username,
          image: caw.parent.user.image
        }
      } : null,
      likeCount: caw.likeCount || 0,
      viewCount: caw.viewCount || 0,
      hasLiked: false,
      hasRecawed: false,
      commentCount: caw.commentCount || 0,
      recawCount: caw.recawCount || 0,
      cawonce: caw.cawonce,
      imageData: caw.imageData,
      imageUrl: null,
      hasImage: caw.hasImage,
      videoData: caw.videoData,
      hasVideo: caw.hasVideo,
      pending: false
    })),
    hasMore
  }
}

/**
 * Search users using Elasticsearch
 */
async function searchUsersWithES(query: string, limit: number, offset: number) {
  const response = await elasticsearchService.search(query, 'users', limit, offset)
  if (!response?.hits?.hits) return null

  const tokenIds = response.hits.hits.map((hit: any) => parseInt(hit._id))
  if (tokenIds.length === 0) return []

  const users = await prisma.user.findMany({
    where: { tokenId: { in: tokenIds } },
    select: {
      tokenId: true,
      username: true,
      displayName: true,
      avatarUrl: true,
      image: true,
      address: true
    }
  })

  // Maintain ES relevance order
  const userMap = new Map(users.map(u => [u.tokenId, u]))
  return tokenIds.map((id: number) => userMap.get(id)).filter(Boolean)
}

/**
 * GET /api/search
 * Search for caws, users, and hashtags
 * Uses Elasticsearch when available, falls back to PostgreSQL
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
    const useES = elasticsearchService.isAvailable()

    const results: any = {
      caws: [],
      users: [],
      hashtags: []
    }

    // Search caws if type is 'all' or 'caws'
    if (type === 'all' || type === 'caws') {
      const cawLimit = type === 'all' ? 10 : searchLimit
      const cawOffset = type === 'all' ? 0 : searchOffset

      let cawResults
      if (useES) {
        cawResults = await searchCawsWithES(query, cawLimit, cawOffset)
      }
      // Fall back to Prisma if ES failed or not available
      if (!cawResults) {
        cawResults = await searchCawsWithPrisma(query, cawLimit, cawOffset)
      }

      results.caws = cawResults.items

      if (type === 'caws') {
        let filteredItems = cawResults.items
        const cawCurrentUserId = Number(req.header('x-user-id')) || undefined
        if (cawCurrentUserId) {
          const blockedIds = await getBlockedUserIds(cawCurrentUserId)
          if (blockedIds.length > 0) {
            const blockedSet = new Set(blockedIds)
            filteredItems = cawResults.items.filter((c: any) => !blockedSet.has(c.user?.id))
          }
        }
        return res.json({
          items: filteredItems,
          nextCursor: cawResults.hasMore ? searchOffset + searchLimit : undefined
        })
      }
    }

    // Search users if type is 'all' or 'users'
    if (type === 'all' || type === 'users') {
      const userLimit = type === 'all' ? 5 : searchLimit
      const userOffset = type === 'all' ? 0 : searchOffset

      let users
      if (useES) {
        users = await searchUsersWithES(query, userLimit, userOffset)
      }
      // Fall back to Prisma if ES failed or not available
      if (!users) {
        users = await prisma.user.findMany({
          where: {
            username: { contains: query, mode: 'insensitive' }
          },
          take: userLimit,
          skip: userOffset,
          orderBy: [
            { followerCount: 'desc' },
            { createdAt: 'desc' }
          ],
          select: {
            tokenId: true,
            username: true,
            displayName: true,
            avatarUrl: true,
            image: true,
            address: true
          }
        })
      }

      // Attach DM identity status to each user
      if (users && users.length > 0) {
        const tokenIds = users.map((u: any) => u.tokenId)
        const dmIdentities = await prisma.dmIdentity.findMany({
          where: { userId: { in: tokenIds } },
          select: { userId: true }
        })
        const dmEnabledSet = new Set(dmIdentities.map(d => d.userId))
        results.users = users.map((u: any) => ({
          ...u,
          hasDmIdentity: dmEnabledSet.has(u.tokenId)
        }))
      } else {
        results.users = users
      }
    }

    // Search hashtags (always use Prisma - hashtags are simple lookups)
    if (type === 'all' || type === 'hashtags') {
      const hashtagLimit = type === 'all' ? 5 : searchLimit
      const hashtagOffset = type === 'all' ? 0 : searchOffset

      const hashtags = await prisma.hashtag.findMany({
        where: {
          name: { contains: query.replace('#', ''), mode: 'insensitive' }
        },
        take: hashtagLimit,
        skip: hashtagOffset,
        orderBy: { usageCount: 'desc' },
        select: {
          name: true,
          usageCount: true
        }
      })
      results.hashtags = hashtags.map(h => ({ tag: h.name, usageCount: h.usageCount }))
    }

    // Filter out blocked users from results
    const currentUserId = Number(req.header('x-user-id')) || undefined
    if (currentUserId) {
      const blockedIds = await getBlockedUserIds(currentUserId)
      if (blockedIds.length > 0) {
        const blockedSet = new Set(blockedIds)
        results.caws = results.caws.filter((c: any) => !blockedSet.has(c.user?.id))
        results.users = results.users.filter((u: any) => !blockedSet.has(u.tokenId))
      }
    }

    // Add hasMore flags for 'all' tab to show "View more" links
    if (type === 'all') {
      const response: any = { ...results }
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
    const useES = elasticsearchService.isAvailable()
    let trendingHashtags: any[] = []

    // Try to get trending hashtags from Elasticsearch (time-windowed)
    if (useES) {
      const esHashtags = await elasticsearchService.getTrendingHashtags('24h', 10)
      if (esHashtags.length > 0) {
        // Get usage counts from database
        const hashtagData = await prisma.hashtag.findMany({
          where: { name: { in: esHashtags } },
          select: { name: true, usageCount: true }
        })
        const countMap = new Map(hashtagData.map(h => [h.name.toLowerCase(), h.usageCount]))
        trendingHashtags = esHashtags.map(tag => ({
          name: tag.replace('#', ''),
          usageCount: countMap.get(tag.replace('#', '').toLowerCase()) || 0
        }))
      }
    }

    // Fall back to Prisma if ES not available or returned no results
    if (trendingHashtags.length === 0) {
      trendingHashtags = await prisma.hashtag.findMany({
        take: 10,
        orderBy: { usageCount: 'desc' },
        select: {
          name: true,
          usageCount: true
        }
      })
    }

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

/**
 * POST /api/search/sync
 * Trigger a full sync of data to Elasticsearch
 */
router.post('/sync', requireAdmin, async (req, res) => {
  try {
    if (!elasticsearchService.isAvailable()) {
      return res.status(503).json({ error: 'Elasticsearch is not available' })
    }

    // Run sync in background
    elasticsearchService.syncAllData().catch(console.error)

    return res.json({ message: 'Sync started in background' })
  } catch (error) {
    console.error('POST /api/search/sync error:', error)
    return res.status(500).json({ error: 'Failed to start sync' })
  }
})

/**
 * GET /api/search/status
 * Check Elasticsearch status
 */
router.get('/status', async (_req, res) => {
  return res.json({
    elasticsearch: elasticsearchService.isAvailable() ? 'connected' : 'disconnected'
  })
})

export default router
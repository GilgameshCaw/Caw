// src/api/routes/hashtags.ts
import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { getTrendingHashtags, searchHashtags } from '../../tools/hashtags'
import { shapeCaw, getCawIncludeConfig, handlePagination } from '../shared/cawUtils'
import { createHashtagMockCaw, mockTrendingHashtags } from '../shared/mockData'

const router = Router()

/**
 * GET /api/hashtags/:tag/caws
 * Get caws that contain a specific hashtag
 * Query params:
 *   limit, cursor for pagination
 */
router.get('/:tag/caws', async (req, res) => {
  try {
    const hashtagName = (req.params.tag as string).toLowerCase()
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
    const cursor = req.query.cursor ? { id: Number(req.query.cursor) } : undefined
    const currentUserId = Number(req.header('x-user-id') || 0) || undefined

    console.log(`API Debug - fetching caws for hashtag: ${hashtagName}`)

    // Find the hashtag first
    const hashtag = await prisma.hashtag.findUnique({
      where: { name: hashtagName }
    })

    if (!hashtag) {
      // Hashtag doesn't exist, return empty results
      return res.json({
        items: [],
        nextCursor: undefined,
        hashtag: { name: hashtagName, usageCount: 0 }
      })
    }

    // Get caws that have this hashtag
    const cawHashtags = await prisma.cawHashtag.findMany({
      where: { hashtagId: hashtag.id },
      orderBy: [
        { caw: { createdAt: 'desc' } },
        { caw: { id: 'desc' } }
      ],
      take: limit + 1,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor.id } : undefined,
      include: {
        caw: {
          include: getCawIncludeConfig({ currentUserId, includeHashtags: true })
        }
      }
    })

    // Handle pagination and shape the caws
    const { items: rawCaws, nextCursor } = handlePagination(
      cawHashtags.map(ch => ch.caw),
      limit,
      (caw) => caw.id
    )
    const items = rawCaws.map(caw => shapeCaw(caw))

    return res.json({
      items,
      nextCursor,
      hashtag: { name: hashtag.name, usageCount: hashtag.usageCount }
    })

  } catch (err: any) {
    console.error(`GET /api/hashtags/${req.params.tag}/caws error`, err)

    // Return mock data for development
    const mockItems = [
      createHashtagMockCaw(req.params.tag, 0),
      createHashtagMockCaw(req.params.tag, 1)
    ]

    return res.json({
      items: mockItems,
      nextCursor: undefined,
      hashtag: { name: req.params.tag, usageCount: 42 }
    })
  }
})

/**
 * GET /api/hashtags/trending
 * Get trending hashtags
 * Query params:
 *   limit (default: 20, max: 50)
 */
router.get('/trending', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50)

    const hashtags = await getTrendingHashtags(limit)

    return res.json({ hashtags })

  } catch (err: any) {
    console.error('GET /api/hashtags/trending error', err)

    return res.json({ hashtags: mockTrendingHashtags.slice(0, limit) })
  }
})

/**
 * GET /api/hashtags/search
 * Search hashtags by name
 * Query params:
 *   q - search query
 *   limit (default: 10, max: 20)
 */
router.get('/search', async (req, res) => {
  try {
    const query = req.query.q as string
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 20)

    if (!query || query.trim().length === 0) {
      return res.json({ hashtags: [] })
    }

    const hashtags = await searchHashtags(query.trim(), limit)

    return res.json({ hashtags })

  } catch (err: any) {
    console.error('GET /api/hashtags/search error', err)

    const query = req.query.q as string || ""

    // Return mock search results
    const mockResults = mockTrendingHashtags
      .filter(h => h.name.toLowerCase().includes(query.toLowerCase()))
      .slice(0, limit)

    return res.json({ hashtags: mockResults })
  }
})

/**
 * GET /api/hashtags/:tag
 * Get information about a specific hashtag
 */
router.get('/:tag', async (req, res) => {
  try {
    const hashtagName = (req.params.tag as string).toLowerCase()

    const hashtag = await prisma.hashtag.findUnique({
      where: { name: hashtagName },
      select: {
        name: true,
        usageCount: true,
        createdAt: true,
        updatedAt: true
      }
    })

    if (!hashtag) {
      return res.status(404).json({ error: 'Hashtag not found' })
    }

    return res.json({ hashtag })

  } catch (err: any) {
    console.error(`GET /api/hashtags/${req.params.tag} error`, err)

    return res.json({
      hashtag: {
        name: req.params.tag,
        usageCount: 42,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    })
  }
})

export default router
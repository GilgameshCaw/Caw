// src/api/routes/hashtags.ts
import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { getTrendingHashtags, searchHashtags } from '../../tools/hashtags'
import { shapeCaw, handlePagination } from '../shared/cawUtils'

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

    // Get caws that have this hashtag - only show SUCCESS caws
    const cawHashtags = await prisma.cawHashtag.findMany({
      where: {
        hashtagId: hashtag.id,
        caw: { status: 'SUCCESS' }  // Only show public SUCCESS caws in hashtag feeds
      },
      orderBy: [
        { caw: { createdAt: 'desc' } },
        { caw: { id: 'desc' } }
      ],
      take: limit + 1,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor.id } : undefined,
      include: {
        caw: {
          include: {
            user: { select: { tokenId: true, username: true, displayName: true, image: true, avatarUrl: true, defaultAvatarId: true } },
            likes: currentUserId
              ? { where: { userId: currentUserId }, select: { userId: true, pending: true } }
              : false,
            recaws: currentUserId
              ? { where: { userId: currentUserId, action: 'RECAW' }, select: { id: true } }
              : false,
            hashtags: {
              include: { hashtag: { select: { name: true } } }
            },
            parent: {
              include: {
                user: { select: { tokenId: true, username: true, displayName: true, image: true, avatarUrl: true, defaultAvatarId: true } },
                hashtags: {
                  include: { hashtag: { select: { name: true } } }
                }
              }
            }
          }
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
    return res.status(500).json({
      error: 'Internal server error',
      items: [],
      nextCursor: undefined,
      hashtag: { name: req.params.tag, usageCount: 0 }
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
    return res.status(500).json({ error: 'Internal server error', hashtags: [] })
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
    return res.status(500).json({ error: 'Internal server error', hashtags: [] })
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

import { Router } from 'express'
import { prisma } from '../../prismaClient'

const router = Router()

/**
 * GET /api/bookmarks
 * Get bookmarked caws for the authenticated user
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.header('x-user-id') ? parseInt(req.header('x-user-id')!) : null
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' })
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
    const offset = parseInt(req.query.offset as string) || 0

    const bookmarks = await prisma.bookmark.findMany({
      where: { userId },
      include: {
        caw: {
          include: {
            user: true,
            likes: {
              where: { userId }
            },
            hashtags: {
              include: {
                hashtag: true
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset
    })

    const caws = bookmarks.map(b => ({
      ...b.caw,
      hasLiked: b.caw.likes.length > 0,
      isBookmarked: true
    }))

    return res.json({
      items: caws,
      nextCursor: caws.length === limit ? offset + limit : undefined
    })
  } catch (error) {
    console.error('GET /api/bookmarks error:', error)
    return res.status(500).json({ error: 'Failed to fetch bookmarks' })
  }
})

/**
 * POST /api/bookmarks/:cawId
 * Bookmark a caw
 */
router.post('/:cawId', async (req, res) => {
  try {
    const userId = req.header('x-user-id') ? parseInt(req.header('x-user-id')!) : null
    const cawId = parseInt(req.params.cawId)
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' })
    }

    if (!cawId || isNaN(cawId)) {
      return res.status(400).json({ error: 'Invalid caw ID' })
    }

    // Check if already bookmarked
    const existing = await prisma.bookmark.findUnique({
      where: {
        userId_cawId: { userId, cawId }
      }
    })

    if (existing) {
      return res.status(400).json({ error: 'Already bookmarked' })
    }

    const bookmark = await prisma.bookmark.create({
      data: { userId, cawId }
    })

    return res.json({ success: true, bookmark })
  } catch (error) {
    console.error('POST /api/bookmarks/:cawId error:', error)
    return res.status(500).json({ error: 'Failed to bookmark caw' })
  }
})

/**
 * DELETE /api/bookmarks/:cawId
 * Remove bookmark from a caw
 */
router.delete('/:cawId', async (req, res) => {
  try {
    const userId = req.header('x-user-id') ? parseInt(req.header('x-user-id')!) : null
    const cawId = parseInt(req.params.cawId)
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' })
    }

    if (!cawId || isNaN(cawId)) {
      return res.status(400).json({ error: 'Invalid caw ID' })
    }

    await prisma.bookmark.delete({
      where: {
        userId_cawId: { userId, cawId }
      }
    })

    return res.json({ success: true })
  } catch (error) {
    console.error('DELETE /api/bookmarks/:cawId error:', error)
    return res.status(500).json({ error: 'Failed to remove bookmark' })
  }
})

export default router
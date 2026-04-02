import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { extractSession } from '../middleware/auth'

const router = Router()

/**
 * Extract authenticated userId from session.
 * Uses x-user-id header but validates it's in the session's authorized token list.
 * Returns null if not authenticated.
 */
async function getAuthenticatedUserId(req: any): Promise<number | null> {
  await extractSession(req)
  if (!req.sessionData) return null

  const requestedId = Number(req.headers['x-user-id'])
  if (!requestedId || isNaN(requestedId)) return null

  // Verify the requested ID is in the session's authorized tokens
  if (!req.sessionData.authorizedTokenIds.includes(requestedId)) return null

  return requestedId
}

/**
 * GET /api/bookmarks
 * Get the current user's bookmarks, paginated (most recent first).
 */
router.get('/', async (req, res) => {
  try {
    const userId = await getAuthenticatedUserId(req)
    if (!userId) return res.status(401).json({ error: 'Authentication required' })

    const cursor = req.query.cursor ? Number(req.query.cursor) : undefined
    const limit = Math.min(Number(req.query.limit) || 20, 50)

    const bookmarks = await prisma.bookmark.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        caw: {
          include: {
            user: true,
            parent: { include: { user: true } },
          }
        }
      }
    })

    const hasMore = bookmarks.length > limit
    const items = hasMore ? bookmarks.slice(0, limit) : bookmarks

    res.json({
      bookmarks: items.map(b => ({
        ...b.caw,
        isBookmarked: true,
        bookmarkId: b.id,
      })),
      hasMore,
      nextCursor: hasMore ? items[items.length - 1].id : undefined,
    })
  } catch (err) {
    console.error('[Bookmarks] GET error:', err)
    res.status(500).json({ error: 'Failed to fetch bookmarks' })
  }
})

/**
 * POST /api/bookmarks/:cawId
 * Bookmark a caw. Only increments bookmarkCount on actual new bookmark.
 */
router.post('/:cawId', async (req, res) => {
  try {
    const userId = await getAuthenticatedUserId(req)
    if (!userId) return res.status(401).json({ error: 'Authentication required' })

    const cawId = Number(req.params.cawId)
    if (!cawId || isNaN(cawId)) {
      return res.status(400).json({ error: 'Invalid cawId' })
    }

    // Check if already bookmarked to avoid double-counting
    const existing = await prisma.bookmark.findUnique({
      where: { userId_cawId: { userId, cawId } },
    })

    if (existing) {
      return res.status(200).json({ bookmark: existing, alreadyExists: true })
    }

    const bookmark = await prisma.bookmark.create({
      data: { userId, cawId },
    })

    await prisma.caw.update({
      where: { id: cawId },
      data: { bookmarkCount: { increment: 1 } },
    })

    res.status(201).json({ bookmark })
  } catch (err: any) {
    if (err?.code === 'P2025') {
      return res.status(404).json({ error: 'Post not found' })
    }
    if (err?.code === 'P2002') {
      return res.status(200).json({ alreadyExists: true })
    }
    console.error('[Bookmarks] POST error:', err)
    res.status(500).json({ error: 'Failed to bookmark' })
  }
})

/**
 * DELETE /api/bookmarks/:cawId
 * Remove a bookmark. Only decrements bookmarkCount if actually deleted.
 */
router.delete('/:cawId', async (req, res) => {
  try {
    const userId = await getAuthenticatedUserId(req)
    if (!userId) return res.status(401).json({ error: 'Authentication required' })

    const cawId = Number(req.params.cawId)
    if (!cawId || isNaN(cawId)) {
      return res.status(400).json({ error: 'Invalid cawId' })
    }

    const deleted = await prisma.bookmark.deleteMany({
      where: { userId, cawId },
    })

    if (deleted.count > 0) {
      await prisma.caw.update({
        where: { id: cawId },
        data: { bookmarkCount: { decrement: 1 } },
      })
    }

    res.json({ success: true })
  } catch (err) {
    console.error('[Bookmarks] DELETE error:', err)
    res.status(500).json({ error: 'Failed to remove bookmark' })
  }
})

export default router

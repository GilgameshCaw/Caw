import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { extractSession } from '../middleware/auth'
import { shapeCaw, getCawIncludeConfig, enrichWithPollVotes, enrichWithXBadges } from '../shared/cawUtils'
import { getBlockedUserIds } from '../shared/blockUtils'

const router = Router()

/**
 * Extract + verify the requesting tokenId from the x-user-id header.
 *
 * Two layers (mirrors pins.ts; this route doesn't go through requireAuth
 * because the userId comes from a header rather than body/query):
 *   1. Session must list this tokenId in authorizedTokenIds.
 *   2. Defense-in-depth: the token's CURRENT on-record owner must be in
 *      the session's authorizedAddresses. Closes the stale-session
 *      window between an L1 transfer and the watcher prune.
 */
async function getAuthenticatedUserId(req: any): Promise<number | null> {
  await extractSession(req)
  if (!req.sessionData) return null

  const requestedId = Number(req.headers['x-user-id'])
  if (!requestedId || isNaN(requestedId)) return null

  if (!req.sessionData.authorizedTokenIds.includes(requestedId)) return null

  const user = await prisma.user.findUnique({
    where:  { tokenId: requestedId },
    select: { address: true },
  })
  if (!user || !user.address) return null
  const ownerAddress = user.address.toLowerCase()
  const authedAddresses = (req.sessionData.authorizedAddresses || []).map((a: string) => a.toLowerCase())
  if (!authedAddresses.includes(ownerAddress)) return null

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

    // Exclude bookmarks whose target caw was deleted/hidden after bookmarking,
    // or whose author the current user has since blocked -- mirrors the
    // status/blockedIds filtering the main feed routes apply (caws.ts).
    const blockedIds = await getBlockedUserIds(userId)
    const cawWhere: any = { status: 'SUCCESS' }
    if (blockedIds.length > 0) {
      cawWhere.userId = { notIn: blockedIds }
    }

    const bookmarks = await prisma.bookmark.findMany({
      where: { userId, caw: cawWhere },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        caw: { include: getCawIncludeConfig({ currentUserId: userId }) },
      }
    })

    const hasMore = bookmarks.length > limit
    const items = hasMore ? bookmarks.slice(0, limit) : bookmarks

    const shapedBookmarks = items.map(b => ({
      ...shapeCaw(b.caw),
      isBookmarked: true,
      bookmarkId: b.id,
    }))
    await enrichWithPollVotes(shapedBookmarks, userId)
    await enrichWithXBadges(shapedBookmarks)

    res.json({
      bookmarks: shapedBookmarks,
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

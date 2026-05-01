import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { extractSession } from '../middleware/auth'

const router = Router()

/**
 * Off-chain pin fallback. Mirrors the on-chain `pi:{cawId}` action — same
 * write semantics — for users who chose "Pin off chain only" in the
 * confirmation modal. The on-chain path goes through the indexer's
 * handlePinAction; this route is the equivalent for the off-chain
 * preference. Reads (profile feed) don't care which path set the field.
 *
 * Single-pin enforcement lives here too: pinning a new caw nulls every
 * other pinned caw owned by the same user.
 */
async function getAuthenticatedUserId(req: any): Promise<number | null> {
  await extractSession(req)
  if (!req.sessionData) return null
  const requestedId = Number(req.headers['x-user-id'])
  if (!requestedId || isNaN(requestedId)) return null
  if (!req.sessionData.authorizedTokenIds.includes(requestedId)) return null
  return requestedId
}

/**
 * POST /api/pins/:cawId — pin the caw to the user's profile.
 * 403 if the caw isn't owned by the requesting user.
 */
router.post('/:cawId', async (req, res) => {
  try {
    const userId = await getAuthenticatedUserId(req)
    if (!userId) return res.status(401).json({ error: 'Authentication required' })

    const cawId = Number(req.params.cawId)
    if (!cawId || isNaN(cawId)) return res.status(400).json({ error: 'Invalid cawId' })

    const target = await prisma.caw.findUnique({
      where: { id: cawId },
      select: { userId: true },
    })
    if (!target) return res.status(404).json({ error: 'Post not found' })
    if (target.userId !== userId) {
      return res.status(403).json({ error: 'You can only pin your own posts' })
    }

    await prisma.$transaction([
      prisma.caw.updateMany({
        where: { userId, pinnedAt: { not: null }, id: { not: cawId } },
        data: { pinnedAt: null },
      }),
      prisma.caw.update({
        where: { id: cawId },
        data: { pinnedAt: new Date() },
      }),
    ])

    res.json({ success: true, cawId })
  } catch (err) {
    console.error('[Pins] POST error:', err)
    res.status(500).json({ error: 'Failed to pin post' })
  }
})

/**
 * DELETE /api/pins/:cawId — unpin a specific caw the user owns. Always
 * succeeds (idempotent): no-op if the caw isn't currently pinned.
 */
router.delete('/:cawId', async (req, res) => {
  try {
    const userId = await getAuthenticatedUserId(req)
    if (!userId) return res.status(401).json({ error: 'Authentication required' })

    const cawId = Number(req.params.cawId)
    if (!cawId || isNaN(cawId)) return res.status(400).json({ error: 'Invalid cawId' })

    await prisma.caw.updateMany({
      where: { id: cawId, userId, pinnedAt: { not: null } },
      data: { pinnedAt: null },
    })

    res.json({ success: true })
  } catch (err) {
    console.error('[Pins] DELETE error:', err)
    res.status(500).json({ error: 'Failed to unpin post' })
  }
})

export default router

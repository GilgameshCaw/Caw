import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { extractSession } from '../middleware/auth'

const router = Router()

/**
 * Off-chain pin fallback. Mirrors the on-chain `pi:{cawId}` / `xpi:{cawId}`
 * action flow but writes the row directly with `pending: false` since
 * there's no indexer round-trip to wait on. Same row schema as the
 * on-chain path so reads don't need to know which path created it.
 *
 * Cap: NOT enforced here. The read path (caws.ts profile feed) only
 * surfaces the 3 most recently pinned. If the user pins a 4th off-chain
 * we let it land — older confirmed pins just don't render until the
 * user unpins one of the visible 3.
 */
/**
 * Extract + verify the requesting tokenId from the x-user-id header.
 *
 * Two layers:
 *   1. Session must list this tokenId in authorizedTokenIds (the wallet
 *      personal_signed for it at sign-in).
 *   2. Defense-in-depth: the token's CURRENT on-record owner must be among
 *      the session's authorizedAddresses. Closes the stale-session window
 *      between an L1 transfer and the watcher prune. Same shape as the
 *      verifyOwnership flag on requireAuth — but pins uses a header
 *      instead of body/query, so we inline rather than re-route through
 *      the middleware.
 *
 * Returns the verified tokenId or null. Caller must 401.
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

    // Bump pinnedCawCount only if this is a fresh pin (no row, or the
    // existing row was pending and we're flipping it to confirmed).
    const existing = await prisma.pinnedCaw.findUnique({
      where: { userId_cawId: { userId, cawId } },
      select: { id: true, pending: true },
    })

    if (!existing) {
      await prisma.$transaction([
        prisma.pinnedCaw.create({
          data: { userId, cawId, pending: false },
        }),
        prisma.user.update({
          where: { tokenId: userId },
          data: { pinnedCawCount: { increment: 1 } },
        }),
      ])
    } else if (existing.pending) {
      await prisma.$transaction([
        prisma.pinnedCaw.update({
          where: { id: existing.id },
          data: { pending: false },
        }),
        prisma.user.update({
          where: { tokenId: userId },
          data: { pinnedCawCount: { increment: 1 } },
        }),
      ])
    }
    // else: already confirmed — idempotent no-op.

    res.json({ success: true, cawId })
  } catch (err) {
    console.error('[Pins] POST error:', err)
    res.status(500).json({ error: 'Failed to pin post' })
  }
})

/**
 * DELETE /api/pins/:cawId — unpin a specific caw the user owns. Idempotent:
 * no-op if the caw isn't currently pinned.
 */
router.delete('/:cawId', async (req, res) => {
  try {
    const userId = await getAuthenticatedUserId(req)
    if (!userId) return res.status(401).json({ error: 'Authentication required' })

    const cawId = Number(req.params.cawId)
    if (!cawId || isNaN(cawId)) return res.status(400).json({ error: 'Invalid cawId' })

    const existing = await prisma.pinnedCaw.findUnique({
      where: { userId_cawId: { userId, cawId } },
      select: { id: true, pending: true },
    })
    if (!existing) {
      return res.json({ success: true })
    }

    // Only decrement if we're removing a confirmed pin — pending rows
    // weren't counted.
    if (existing.pending) {
      await prisma.pinnedCaw.delete({ where: { id: existing.id } })
    } else {
      await prisma.$transaction([
        prisma.pinnedCaw.delete({ where: { id: existing.id } }),
        prisma.user.update({
          where: { tokenId: userId },
          data: { pinnedCawCount: { decrement: 1 } },
        }),
      ])
    }

    res.json({ success: true })
  } catch (err) {
    console.error('[Pins] DELETE error:', err)
    res.status(500).json({ error: 'Failed to unpin post' })
  }
})

export default router

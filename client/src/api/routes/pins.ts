import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { recomputePinnedCount } from '../../utils/pinnedCount'
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
      select: { id: true, pending: true, pendingUnpin: true },
    })

    // #222: pinnedCawCount is derived from the deduped rows, not delta-
    // mutated, so it can't drift under racing confirm paths. Recompute in
    // the same tx as every row change.
    if (!existing) {
      await prisma.$transaction(async (tx) => {
        await tx.pinnedCaw.create({
          data: { userId, cawId, pending: false },
        })
        await recomputePinnedCount(tx, userId)
      })
    } else if (existing.pending) {
      // Pending pin getting confirmed off-chain. Clear pendingUnpin too
      // in case a stale unpin flag survived a re-pin cycle.
      await prisma.$transaction(async (tx) => {
        await tx.pinnedCaw.update({
          where: { id: existing.id },
          data: { pending: false, pendingUnpin: false },
        })
        await recomputePinnedCount(tx, userId)
      })
    } else if (existing.pendingUnpin) {
      // Already-confirmed pin with an on-chain unpin in flight. The new
      // pin supersedes it; clearing pendingUnpin makes the row visible and
      // counted again — recompute picks that up.
      await prisma.$transaction(async (tx) => {
        await tx.pinnedCaw.update({
          where: { id: existing.id },
          data: { pendingUnpin: false },
        })
        await recomputePinnedCount(tx, userId)
      })
    }
    // else: already confirmed and not unpin-pending — idempotent no-op.

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

    // Derive the count from the remaining rows — handles confirmed vs
    // pending uniformly (pending rows aren't counted, so removing one is
    // a recompute no-op) and self-heals any prior drift.
    await prisma.$transaction(async (tx) => {
      await tx.pinnedCaw.delete({ where: { id: existing.id } })
      await recomputePinnedCount(tx, userId)
    })

    res.json({ success: true })
  } catch (err) {
    console.error('[Pins] DELETE error:', err)
    res.status(500).json({ error: 'Failed to unpin post' })
  }
})

export default router

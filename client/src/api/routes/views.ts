import { Router, Request } from 'express'
import { trackView, trackBulkViews, getTrendingByViews } from '../../services/ViewTracker'
import { extractSession } from '../middleware/auth'
import { prisma } from '../../prismaClient'
import crypto from 'crypto'

const router = Router()

/**
 * Helper to hash IP address for privacy
 */
function hashIP(ip: string): string {
  return crypto.createHash('sha256').update(ip + (process.env.IP_SALT || 'default-salt')).digest('hex')
}

/**
 * Resolve a trusted userId for view-count deduplication.
 *
 * /track and /track-bulk are unauthenticated so anonymous visitors can view
 * caws, but the `x-user-id` header must never be trusted blindly: an
 * attacker rotating x-user-id without a session would bypass the 24-hour
 * Redis dedup set (keyed on `user:${id}`) and arbitrarily inflate view
 * counts to manipulate trending feeds.
 *
 * Verification mirrors getAuthenticatedUserId in bookmarks.ts/pins.ts:
 *   1. Session must list the requested tokenId in authorizedTokenIds.
 *   2. Defense-in-depth: the token's CURRENT on-record owner must be in
 *      the session's authorizedAddresses. Closes the stale-session window
 *      between an L1 transfer and the watcher prune — otherwise a
 *      previous owner's still-live session could attribute views to a
 *      token they no longer hold.
 *
 * Unlike bookmarks/pins, failure here never 401s: views must stay
 * viewable without a session. An invalid/unauthorized/unrecognized
 * requested tokenId falls back to the session's own primary token, but a
 * *stale-ownership* failure (the requested token's on-record owner no
 * longer matches the session) falls back to undefined instead — returning
 * ownTokenId there would be a no-op for the common single-token case,
 * since ownTokenId and requestedId are the same id. No session at all
 * also returns undefined. Either way ViewTracker keys on `ip:${ipHash}`.
 */
async function resolveTrustedUserId(req: Request): Promise<number | undefined> {
  await extractSession(req)
  if (!req.sessionData) return undefined

  const ownTokenId = req.sessionData.authorizedTokenIds[0]
  const rawHeader = req.header('x-user-id')
  const requestedId = rawHeader ? Number(rawHeader) : undefined
  if (!requestedId || !Number.isFinite(requestedId)) return ownTokenId
  if (!req.sessionData.authorizedTokenIds.includes(requestedId)) return ownTokenId

  const user = await prisma.user.findUnique({
    where: { tokenId: requestedId },
    select: { address: true },
  })
  if (!user?.address) return ownTokenId

  const ownerAddress = user.address.toLowerCase()
  const authedAddresses = (req.sessionData.authorizedAddresses || []).map(a => a.toLowerCase())
  if (!authedAddresses.includes(ownerAddress)) return undefined

  return requestedId
}

/**
 * POST /api/views/track
 * Track a single view for a caw
 */
router.post('/track', async (req, res) => {
  try {
    const { cawId } = req.body
    const parsedCawId = Number(cawId)
    if (!Number.isFinite(parsedCawId) || parsedCawId <= 0) {
      return res.status(400).json({ error: 'Valid positive cawId is required' })
    }

    const userId = await resolveTrustedUserId(req)
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const ipHash = hashIP(ip)

    await trackView({
      cawId: parsedCawId,
      userId,
      ipHash
    })

    return res.json({ success: true })

  } catch (error) {
    console.error('POST /api/views/track error:', error)
    return res.status(500).json({ error: 'Failed to track view' })
  }
})

/**
 * POST /api/views/track-bulk
 * Track views for multiple caws at once (efficient for feed loading)
 */
router.post('/track-bulk', async (req, res) => {
  try {
    const { cawIds } = req.body

    if (!cawIds || !Array.isArray(cawIds)) {
      return res.status(400).json({ error: 'cawIds array is required' })
    }

    // Limit to 100 caws per request for safety. Drop any non-finite values
    // so a stray null/undefined/NaN in the array can't poison the batch.
    const limitedCawIds = cawIds
      .slice(0, 100)
      .map(id => Number(id))
      .filter(id => Number.isFinite(id) && id > 0)

    if (limitedCawIds.length === 0) {
      return res.json({ success: true, tracked: 0 })
    }

    const userId = await resolveTrustedUserId(req)
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const ipHash = hashIP(ip)

    await trackBulkViews(limitedCawIds, userId, ipHash)

    return res.json({ success: true, tracked: limitedCawIds.length })

  } catch (error) {
    // View tracking is best-effort — don't surface infra errors (Redis hiccup,
    // etc.) as 500s that pollute the client console. Log and return success.
    console.error('POST /api/views/track-bulk error:', error)
    return res.json({ success: true, tracked: 0 })
  }
})

/**
 * GET /api/views/trending
 * Get caws trending by view count
 */
router.get('/trending', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50)

    const trendingCawIds = await getTrendingByViews(limit)

    return res.json({ cawIds: trendingCawIds })

  } catch (error) {
    console.error('GET /api/views/trending error:', error)
    return res.status(500).json({ error: 'Failed to get trending caws' })
  }
})

export default router
import { Router } from 'express'
import { trackView, trackBulkViews, getTrendingByViews } from '../../services/ViewTracker'
import crypto from 'crypto'

const router = Router()

/**
 * Helper to hash IP address for privacy
 */
function hashIP(ip: string): string {
  return crypto.createHash('sha256').update(ip + (process.env.IP_SALT || 'default-salt')).digest('hex')
}

/**
 * POST /api/views/track
 * Track a single view for a caw
 */
router.post('/track', async (req, res) => {
  try {
    const { cawId } = req.body
    const userId = req.header('x-user-id') ? Number(req.header('x-user-id')) : undefined
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const ipHash = hashIP(ip)

    if (!cawId) {
      return res.status(400).json({ error: 'cawId is required' })
    }

    await trackView({
      cawId: Number(cawId),
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
    const userId = req.header('x-user-id') ? Number(req.header('x-user-id')) : undefined
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const ipHash = hashIP(ip)

    if (!cawIds || !Array.isArray(cawIds)) {
      return res.status(400).json({ error: 'cawIds array is required' })
    }

    // Limit to 100 caws per request for safety
    const limitedCawIds = cawIds.slice(0, 100).map(id => Number(id))

    await trackBulkViews(limitedCawIds, userId, ipHash)

    return res.json({ success: true, tracked: limitedCawIds.length })

  } catch (error) {
    console.error('POST /api/views/track-bulk error:', error)
    return res.status(500).json({ error: 'Failed to track views' })
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
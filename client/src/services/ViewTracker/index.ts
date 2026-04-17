import { prisma } from '../../prismaClient'
import Redis from 'ioredis'

const redis = new Redis({
  port: 6379,
  host: '127.0.0.1',
})

interface ViewData {
  cawId: number
  userId?: number // Optional for authenticated users
  ipHash?: string // For anonymous users
}

/**
 * Track a view for a caw
 * Uses Redis to cache views and batch database updates
 * Prevents duplicate views from same user/IP within a time window
 */
export async function trackView(data: ViewData): Promise<void> {
  const { cawId, userId, ipHash } = data

  // Create a unique identifier for this viewer
  const viewerKey = userId ? `user:${userId}` : `ip:${ipHash}`
  const viewKey = `caw:${cawId}:views:${viewerKey}`

  try {
    // Check if this viewer has already viewed this caw recently (24 hour window)
    const exists = await redis.get(viewKey)
    if (exists) {
      return // Already viewed, skip
    }

    // Mark this view and set expiry for 24 hours
    await redis.setex(viewKey, 86400, '1')

    // Increment the view counter in Redis
    await redis.hincrby('caw:views:pending', cawId.toString(), 1)

  } catch (error) {
    console.error('[ViewTracker] Error tracking view:', error)
  }
}

/**
 * Track multiple views at once (for feed loading)
 * More efficient for bulk operations
 */
export async function trackBulkViews(cawIds: number[], userId?: number, ipHash?: string): Promise<void> {
  const viewerKey = userId ? `user:${userId}` : `ip:${ipHash}`

  try {
    const pipeline = redis.pipeline()

    for (const cawId of cawIds) {
      const viewKey = `caw:${cawId}:views:${viewerKey}`

      // Check and set in pipeline for efficiency
      pipeline.get(viewKey)
    }

    const results = await pipeline.exec()

    const newViews: number[] = []
    results?.forEach((result, index) => {
      if (!result[1]) { // Not viewed yet
        newViews.push(cawIds[index])
      }
    })

    if (newViews.length > 0) {
      const bulkPipeline = redis.pipeline()

      for (const cawId of newViews) {
        const viewKey = `caw:${cawId}:views:${viewerKey}`
        bulkPipeline.setex(viewKey, 86400, '1')
        bulkPipeline.hincrby('caw:views:pending', cawId.toString(), 1)
      }

      await bulkPipeline.exec()
    }

  } catch (error) {
    console.error('[ViewTracker] Error tracking bulk views:', error)
  }
}

/**
 * Sync pending view counts from Redis to database
 * This runs periodically to batch database updates
 */
async function syncViewsToDatabase() {
  console.log('[ViewTracker] Syncing views to database...')

  try {
    // Get all pending view counts
    const pendingViews = await redis.hgetall('caw:views:pending')

    if (Object.keys(pendingViews).length === 0) {
      return // Nothing to sync
    }

    // Batch update all caws with their view increments
    const updates = Object.entries(pendingViews).map(([cawId, increment]) => ({
      cawId: parseInt(cawId),
      increment: parseInt(increment)
    }))

    // Update database in a transaction (use interactive form — the Prisma
    // proxy doesn't produce PrismaPromise objects the array form requires)
    await prisma.$transaction(async (tx) => {
      for (const { cawId, increment } of updates) {
        await tx.caw.update({
          where: { id: cawId },
          data: { viewCount: { increment } }
        })
      }
    })

    // Clear the pending views
    await redis.del('caw:views:pending')

    console.log(`[ViewTracker] Synced ${updates.length} caw view counts to database`)

  } catch (error) {
    console.error('[ViewTracker] Error syncing views to database:', error)
  }
}

/**
 * Get trending caws based on recent views
 * Uses a sliding window approach with Redis sorted sets
 */
export async function getTrendingByViews(limit: number = 10): Promise<number[]> {
  try {
    // Get caw IDs sorted by recent view activity
    const trending = await redis.zrevrange('caw:trending:views', 0, limit - 1)
    return trending.map(id => parseInt(id))
  } catch (error) {
    console.error('[ViewTracker] Error getting trending caws:', error)
    return []
  }
}

/**
 * Update trending scores based on view velocity
 * Runs periodically to maintain trending list
 */
async function updateTrendingScores() {
  try {
    // Get recent views from the last hour
    const recentViews = await redis.hgetall('caw:views:pending')

    if (Object.keys(recentViews).length > 0) {
      const pipeline = redis.pipeline()

      // Update trending scores with time decay
      for (const [cawId, views] of Object.entries(recentViews)) {
        const score = parseInt(views) * Math.exp(-0.1) // Time decay factor
        pipeline.zincrby('caw:trending:views', score, cawId)
      }

      // Remove old entries (keep top 1000)
      pipeline.zremrangebyrank('caw:trending:views', 0, -1001)

      await pipeline.exec()
    }
  } catch (error) {
    console.error('[ViewTracker] Error updating trending scores:', error)
  }
}

/**
 * Start the view tracker background worker
 */
function startViewTrackerWorker(heartbeat?: (loopName: string) => void) {
  console.log('[ViewTracker] Starting background worker...')

  const syncAndBeat = async () => {
    try { await syncViewsToDatabase() } finally { heartbeat?.('sync-views') }
  }
  const trendAndBeat = async () => {
    try { await updateTrendingScores() } finally { heartbeat?.('trending') }
  }

  // Sync views to database every 30 seconds
  setInterval(syncAndBeat, 30 * 1000)

  // Update trending scores every 5 minutes
  setInterval(trendAndBeat, 5 * 60 * 1000)

  // Run initial sync
  syncAndBeat()
  trendAndBeat()
}

// Export for use as a service
export const viewTrackerService = {
  name: 'ViewTracker',

  validateConfig(cfg: unknown) {
    return []
  },

  start(_cfg: unknown, ctx: import('../../Service').HeartbeatContext) {
    ctx.declareLoop('sync-views', 3 * 60_000) // 6× 30s interval
    ctx.declareLoop('trending', 15 * 60_000) // 3× 5min interval
    startViewTrackerWorker((name) => ctx.heartbeat(name))

    return {
      started: Promise.resolve(),
      async stop() {
        await redis.quit()
        await prisma.$disconnect()
      },
      stats: async () => 'Tracking views and syncing to database every 30 seconds'
    }
  }
}
import { prisma } from '../prismaClient'
import { createClient } from 'redis'

// Initialize Redis client
const redis = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
})

redis.on('error', err => console.log('Redis Client Error', err))
redis.connect().catch(console.error)

interface ViewData {
  cawId: number
  userId?: number
  ipHash: string
}

/**
 * Track a single view for a caw
 */
export async function trackView({ cawId, userId, ipHash }: ViewData): Promise<void> {
  // Create a unique key for this viewer
  const viewKey = userId ? `user:${userId}` : `ip:${ipHash}`
  const cawViewKey = `caw:${cawId}:viewers`

  // Check if this viewer has already viewed this caw in the last 24 hours
  const alreadyViewed = await redis.sIsMember(cawViewKey, viewKey)

  if (!alreadyViewed) {
    // Add viewer to the set with 24-hour expiry
    await redis.sAdd(cawViewKey, viewKey)
    await redis.expire(cawViewKey, 86400) // 24 hours

    // Increment view count in database
    await prisma.caw.update({
      where: { id: cawId },
      data: { viewCount: { increment: 1 } }
    })

    // Also increment in Redis for fast access
    await redis.incr(`caw:${cawId}:viewcount`)
  }
}

/**
 * Track views for multiple caws at once
 */
export async function trackBulkViews(cawIds: number[], userId?: number, ipHash?: string): Promise<void> {
  if (!ipHash) return

  const viewKey = userId ? `user:${userId}` : `ip:${ipHash}`

  // Process each caw
  const promises = cawIds.map(async (cawId) => {
    const cawViewKey = `caw:${cawId}:viewers`

    // Check if already viewed
    const alreadyViewed = await redis.sIsMember(cawViewKey, viewKey)

    if (!alreadyViewed) {
      // Add to viewers set
      await redis.sAdd(cawViewKey, viewKey)
      await redis.expire(cawViewKey, 86400) // 24 hours

      // Increment in Redis
      await redis.incr(`caw:${cawId}:viewcount`)

      return cawId // Return cawId to update in DB
    }
    return null
  })

  const results = await Promise.all(promises)
  const cawsToUpdate = results.filter(id => id !== null) as number[]

  // Bulk update view counts in database. Single `updateMany` instead of N
  // serial round-trips inside a transaction — at 20 caws on a feed page
  // this drops 20 DB round-trips to 1. Audit fix 2026-05-13.
  if (cawsToUpdate.length > 0) {
    await prisma.caw.updateMany({
      where: { id: { in: cawsToUpdate } },
      data: { viewCount: { increment: 1 } }
    })
  }
}

/**
 * Get trending caws by view count.
 *
 * Filters to caws with a minimum view threshold so the planner can use a
 * partial index scan rather than reading every row from the last 7 days
 * just to sort them. The threshold is intentionally cheap-to-reach (5
 * views) — at scale this is the difference between scanning the entire
 * 7-day window and scanning a small "interesting" subset. Most caws
 * never accrue 5 views and don't belong in "trending" output anyway.
 * Audit fix 2026-05-13.
 */
export async function getTrendingByViews(limit: number = 10): Promise<number[]> {
  const trending = await prisma.caw.findMany({
    where: {
      createdAt: {
        gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Last 7 days
      },
      viewCount: { gte: 5 }
    },
    orderBy: { viewCount: 'desc' },
    take: limit,
    select: { id: true }
  })

  return trending.map(caw => caw.id)
}

/**
 * Get view count for a caw (from Redis cache first, fallback to DB)
 */
export async function getViewCount(cawId: number): Promise<number> {
  // Try Redis first
  const cachedCount = await redis.get(`caw:${cawId}:viewcount`)
  if (cachedCount !== null) {
    return parseInt(cachedCount)
  }

  // Fallback to database
  const caw = await prisma.caw.findUnique({
    where: { id: cawId },
    select: { viewCount: true }
  })

  const count = caw?.viewCount || 0

  // Cache in Redis
  await redis.set(`caw:${cawId}:viewcount`, count, {
    EX: 3600 // 1 hour cache
  })

  return count
}

/**
 * Get view counts for multiple caws
 */
export async function getViewCounts(cawIds: number[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>()

  // Get all counts from Redis in parallel
  const promises = cawIds.map(async (cawId) => {
    const count = await getViewCount(cawId)
    counts.set(cawId, count)
  })

  await Promise.all(promises)

  return counts
}
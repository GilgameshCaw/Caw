import { Router } from 'express'
import { prisma } from '../../prismaClient'

const router = Router()

/**
 * CAW burn cost per username length (whole tokens, matches CawProfileMinter.sol)
 */
function mintCostByLength(len: number): bigint {
  switch (len) {
    case 1:  return 1_000_000_000_000n
    case 2:  return 240_000_000_000n
    case 3:  return 60_000_000_000n
    case 4:  return 6_000_000_000n
    case 5:  return 200_000_000n
    case 6:  return 20_000_000n
    case 7:  return 10_000_000n
    default: return 1_000_000n // 8+
  }
}

// Cache burned total for 1 hour — the only input is username lengths, which
// only change when someone mints a new name. 1-hour staleness is fine for
// a stats page. Previous 5-min TTL was overkill and made cache misses expensive.
let burnedCache: { value: string; expiry: number } | null = null

async function getTotalCawBurned(): Promise<string> {
  if (burnedCache && Date.now() < burnedCache.expiry) return burnedCache.value

  // Group by username length IN THE DATABASE. Returns at most ~20 rows (one
  // per length). Previous approach did findMany({select:{username:true}}) and
  // looped in JS — O(N) memory + time. Now O(distinct lengths).
  const groups = await prisma.$queryRaw<Array<{ len: number; count: bigint }>>`
    SELECT LENGTH(username)::int AS len, COUNT(*)::bigint AS count
    FROM "User"
    GROUP BY LENGTH(username)
  `
  let total = 0n
  for (const g of groups) {
    total += mintCostByLength(g.len) * BigInt(g.count)
  }
  const result = total.toString()
  burnedCache = { value: result, expiry: Date.now() + 60 * 60 * 1000 }
  return result
}

/**
 * GET /api/stats
 * Returns community statistics
 */
router.get('/', async (_req, res) => {
  try {
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

    // Run all queries in parallel
    const [totalUsers, totalPosts, postsToday, newMembersThisWeek, activeUsersThisWeek, totalCawBurned] = await Promise.all([
      // Total users
      prisma.user.count(),

      // Total posts (excluding pending/failed)
      prisma.caw.count({
        where: {
          status: 'SUCCESS'
        }
      }),

      // Posts today
      prisma.caw.count({
        where: {
          createdAt: { gte: todayStart },
          status: 'SUCCESS'
        }
      }),

      // New members this week
      prisma.user.count({
        where: {
          createdAt: { gte: weekAgo }
        }
      }),

      // Active users this week (users who posted). Use COUNT(DISTINCT) in SQL
      // instead of groupBy + .length — groupBy enumerates every user group
      // into memory, the distinct count does not.
      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(DISTINCT "userId")::bigint AS count
        FROM "Caw"
        WHERE "createdAt" >= ${weekAgo} AND "status" = 'SUCCESS'
      `.then(rows => Number(rows[0]?.count ?? 0)),

      // Total CAW burned through username minting
      getTotalCawBurned()
    ])

    res.json({
      totalUsers,
      totalPosts,
      postsToday,
      newMembersThisWeek,
      activeUsersThisWeek,
      totalCawBurned
    })
  } catch (error) {
    console.error('Error fetching stats:', error)
    res.status(500).json({ error: 'Failed to fetch stats' })
  }
})

export default router

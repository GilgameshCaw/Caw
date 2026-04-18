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

// Cache burned total for 5 minutes since it requires scanning all usernames
let burnedCache: { value: string; expiry: number } | null = null

async function getTotalCawBurned(): Promise<string> {
  if (burnedCache && Date.now() < burnedCache.expiry) return burnedCache.value

  const users = await prisma.user.findMany({ select: { username: true } })
  let total = 0n
  for (const u of users) {
    total += mintCostByLength(u.username.length)
  }
  const result = total.toString()
  burnedCache = { value: result, expiry: Date.now() + 5 * 60 * 1000 }
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

      // Active users this week (users who posted)
      prisma.caw.groupBy({
        by: ['userId'],
        where: {
          createdAt: { gte: weekAgo },
          status: 'SUCCESS'
        }
      }).then(groups => groups.length),

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

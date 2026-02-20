import { Router } from 'express'
import { prisma } from '../../prismaClient'

const router = Router()

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
    const [totalUsers, totalPosts, postsToday, newMembersThisWeek, activeUsersThisWeek] = await Promise.all([
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
      }).then(groups => groups.length)
    ])

    res.json({
      totalUsers,
      totalPosts,
      postsToday,
      newMembersThisWeek,
      activeUsersThisWeek
    })
  } catch (error) {
    console.error('Error fetching stats:', error)
    res.status(500).json({ error: 'Failed to fetch stats' })
  }
})

export default router

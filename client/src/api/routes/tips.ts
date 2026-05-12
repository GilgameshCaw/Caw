import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { requireAuth } from '../middleware/auth'

const router = Router()

/**
 * GET /api/tips/post/:cawId
 * Get tips on a specific post
 */
router.get('/post/:cawId', async (req, res) => {
  try {
    const cawId = parseInt(req.params.cawId)
    if (isNaN(cawId)) {
      return res.status(400).json({ error: 'Valid cawId is required' })
    }

    const limit = Math.min(Number(req.query.limit) || 20, 100)
    const offset = Number(req.query.offset) || 0

    const [tips, totalCount] = await Promise.all([
      prisma.tip.findMany({
        where: { cawId },
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
        include: {
          sender: {
            select: {
              tokenId: true,
              username: true,
              displayName: true,
              avatarUrl: true, defaultAvatarId: true
            }
          }
        }
      }),
      prisma.tip.count({ where: { cawId } })
    ])

    const totalAmount = tips.reduce((sum, tip) => sum + tip.amount, 0)

    return res.json({ tips, totalAmount, count: totalCount, hasMore: offset + tips.length < totalCount })
  } catch (error) {
    console.error('GET /api/tips/post/:cawId error:', error)
    return res.status(500).json({ error: 'Failed to get tips' })
  }
})

/**
 * GET /api/tips/sent
 * Get tips sent by the authenticated user. The userId is read from the
 * authenticated session, not from a header — the previous version trusted
 * `x-user-id` from the client and would happily return any user's sent-tip
 * history. Audit fix 2026-05-13.
 */
router.get('/sent', requireAuth({ lookup: async (req) => Number(req.header('x-user-id')), verifyOwnership: true }), async (req, res) => {
  try {
    const userId = Number(req.header('x-user-id'))
    if (!userId) {
      return res.status(400).json({ error: 'x-user-id header is required' })
    }

    const { limit = 50, offset = 0 } = req.query

    const tips = await prisma.tip.findMany({
      where: { senderId: userId },
      take: Math.min(Number(limit), 100),
      skip: Number(offset),
      orderBy: { createdAt: 'desc' },
      include: {
        recipient: {
          select: {
            tokenId: true,
            username: true,
            displayName: true,
            avatarUrl: true, defaultAvatarId: true
          }
        }
      }
    })

    return res.json({ tips })
  } catch (error) {
    console.error('GET /api/tips/sent error:', error)
    return res.status(500).json({ error: 'Failed to get sent tips' })
  }
})

/**
 * GET /api/tips/received
 * Get tips received by the authenticated user. The userId param is verified
 * against the authenticated session via requireAuth's verifyOwnership flag —
 * the previous version was unauthenticated and would return any user's
 * received-tip history given a userId query param. Audit fix 2026-05-13.
 */
router.get('/received', requireAuth({ lookup: async (req) => Number(req.query.userId), verifyOwnership: true }), async (req, res) => {
  try {
    const { userId, limit = 50, offset = 0 } = req.query
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' })
    }

    const userTokenId = parseInt(userId as string)

    const tips = await prisma.tip.findMany({
      where: { recipientId: userTokenId },
      take: Math.min(Number(limit), 100),
      skip: Number(offset),
      orderBy: { createdAt: 'desc' },
      include: {
        sender: {
          select: {
            tokenId: true,
            username: true,
            displayName: true,
            avatarUrl: true, defaultAvatarId: true
          }
        }
      }
    })

    const totalAmount = tips.reduce((sum, tip) => sum + tip.amount, 0)

    return res.json({ tips, totalAmount })
  } catch (error) {
    console.error('GET /api/tips/received error:', error)
    return res.status(500).json({ error: 'Failed to get received tips' })
  }
})

export default router

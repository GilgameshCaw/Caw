import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { requireAuth } from '../middleware/auth'

const router = Router()

/**
 * GET /api/blocks?userId=X
 * List all users blocked by the given user
 */
router.get('/',
  requireAuth({ lookup: async (req) => Number(req.query.userId), verifyOwnership: true }),
  async (req: any, res: any) => {
    try {
      const userId = Number(req.query.userId)

      const blocks = await prisma.block.findMany({
        where: { blockerId: userId },
        include: {
          blocked: {
            select: {
              tokenId: true,
              username: true,
              displayName: true,
              avatarUrl: true, defaultAvatarId: true,
              image: true
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      })

      const blockedUsers = blocks.map((b: any) => ({
        tokenId: b.blocked.tokenId,
        username: b.blocked.username,
        displayName: b.blocked.displayName,
        avatarUrl: b.blocked.avatarUrl,
        image: b.blocked.image,
        blockedAt: b.createdAt
      }))

      res.json({ blockedUsers })
    } catch (err: any) {
      console.error('GET /api/blocks error:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

/**
 * POST /api/blocks
 * Block a user
 */
router.post('/',
  requireAuth({ field: 'blockerId', verifyOwnership: true }),
  async (req: any, res: any) => {
    try {
      const { blockerId, blockedId } = req.body

      if (!blockerId || !blockedId) {
        return res.status(400).json({ error: 'blockerId and blockedId are required' })
      }

      if (blockerId === blockedId) {
        return res.status(400).json({ error: 'Cannot block yourself' })
      }

      await prisma.block.upsert({
        where: {
          blockerId_blockedId: { blockerId, blockedId }
        },
        update: {},
        create: { blockerId, blockedId }
      })

      // Also remove any follow relationships in both directions
      await prisma.follow.deleteMany({
        where: {
          OR: [
            { followerId: blockerId, followingId: blockedId },
            { followerId: blockedId, followingId: blockerId }
          ]
        }
      })

      res.json({ success: true })
    } catch (err: any) {
      console.error('POST /api/blocks error:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

/**
 * DELETE /api/blocks
 * Unblock a user
 */
router.delete('/',
  requireAuth({ field: 'blockerId', verifyOwnership: true }),
  async (req: any, res: any) => {
    try {
      const { blockerId, blockedId } = req.body

      if (!blockerId || !blockedId) {
        return res.status(400).json({ error: 'blockerId and blockedId are required' })
      }

      await prisma.block.deleteMany({
        where: { blockerId, blockedId }
      })

      res.json({ success: true })
    } catch (err: any) {
      console.error('DELETE /api/blocks error:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

export default router

import { Router } from 'express'
import { prisma } from '../../prismaClient'

const router = Router()

/**
 * GET /api/withdrawals/:userId
 * Fetch withdrawal requests for a specific user
 */
router.get('/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId)

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid userId parameter' })
    }

    console.log(`[Withdrawals API] Fetching withdrawal requests for user ${userId}`)

    const withdrawalRequests = await prisma.withdrawalRequest.findMany({
      where: {
        userId
      },
      orderBy: {
        createdAt: 'desc'
      }
    })

    console.log(`[Withdrawals API] Found ${withdrawalRequests.length} withdrawal requests for user ${userId}`)

    res.json({
      success: true,
      withdrawals: withdrawalRequests
    })
  } catch (err: any) {
    console.error('[Withdrawals API] Error fetching withdrawal requests:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

/**
 * GET /api/withdrawals/:userId/pending
 * Fetch only pending withdrawal requests for a specific user
 */
router.get('/:userId/pending', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId)

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid userId parameter' })
    }

    console.log(`[Withdrawals API] Fetching pending withdrawal requests for user ${userId}`)

    const pendingWithdrawals = await prisma.withdrawalRequest.findMany({
      where: {
        userId,
        status: 'pending'
      },
      orderBy: {
        createdAt: 'desc'
      }
    })

    console.log(`[Withdrawals API] Found ${pendingWithdrawals.length} pending withdrawal requests for user ${userId}`)

    res.json({
      success: true,
      withdrawals: pendingWithdrawals
    })
  } catch (err: any) {
    console.error('[Withdrawals API] Error fetching pending withdrawal requests:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

export default router

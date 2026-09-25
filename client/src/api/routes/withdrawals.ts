import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { requireAuth } from '../middleware/auth'

const router = Router()

/**
 * GET /api/withdrawals/:userId
 * Fetch withdrawal requests for a specific user. Auth: caller must be
 * authorized for tokenId == userId. Without this, anyone could enumerate
 * every user's withdrawal history (amounts, txHashes, status). Audit
 * fix 2026-05-09 (Round 5 API HIGH-5).
 */
router.get('/:userId', requireAuth({ lookup: async (req) => Number(req.params.userId), verifyOwnership: true }), async (req, res) => {
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

    // Attach the underlying TxQueue status for each withdrawal so the frontend
    // can reliably detect failed/stuck withdraws. WithdrawalRequest.status is
    // updated by the validator in a separate step that can miss edge cases;
    // TxQueue.status is authoritative for whether the action itself settled.
    //
    // Also — if we see an authoritative terminal TxQueue status (failed or
    // cancelled) but the WithdrawalRequest is still 'pending', self-heal: flip
    // the row to 'failed' so the next poll returns clean data.
    const cawonces = withdrawalRequests.map(w => w.cawonce)
    // Look the rows up by the TxQueue.cawonce column, which every insert path
    // stamps (the batch endpoint in actions.ts queries it the same way). A
    // fixed window of the sender's most recent rows missed any withdrawal that
    // had more than that many queue rows after it. Newest row per cawonce wins,
    // so a retried withdrawal reports its latest attempt.
    const txQueueRows = cawonces.length > 0
      ? await prisma.txQueue.findMany({
          where: { senderId: userId, cawonce: { in: cawonces } },
          select: { id: true, status: true, reason: true, cawonce: true },
          orderBy: { createdAt: 'desc' },
        })
      : []
    const txqByCawonce = new Map<number, { status: string; reason: string | null }>()
    for (const row of txQueueRows) {
      const c = row.cawonce
      if (typeof c === 'number' && !txqByCawonce.has(c)) {
        txqByCawonce.set(c, { status: row.status, reason: row.reason ?? null })
      }
    }

    // Self-heal stuck pending rows whose TxQueue ended without being sent:
    // failed, or cancelled by the sender (POST /api/txqueue/:id/cancel only
    // flips pending rows and doesn't touch WithdrawalRequest). 'underpriced'
    // is left alone: the validator keeps it for a possible relay.
    const unsentTerminal = new Set(['failed', 'cancelled'])
    const stuckIds: number[] = []
    for (const w of withdrawalRequests) {
      if (w.status === 'pending') {
        const txq = txqByCawonce.get(w.cawonce)
        if (txq && unsentTerminal.has(txq.status)) stuckIds.push(w.id)
      }
    }
    if (stuckIds.length > 0) {
      await prisma.withdrawalRequest.updateMany({
        where: { id: { in: stuckIds } },
        data: { status: 'failed' },
      })
      console.log(`[Withdrawals API] Self-healed ${stuckIds.length} stuck pending withdrawals for user ${userId}`)
      for (const w of withdrawalRequests) {
        if (stuckIds.includes(w.id)) w.status = 'failed'
      }
    }

    const withdrawalsWithTxStatus = withdrawalRequests.map(w => ({
      ...w,
      txQueueStatus: txqByCawonce.get(w.cawonce)?.status ?? null,
      txQueueReason: txqByCawonce.get(w.cawonce)?.reason ?? null,
    }))

    console.log(`[Withdrawals API] Found ${withdrawalRequests.length} withdrawal requests for user ${userId}`)

    res.json({
      success: true,
      withdrawals: withdrawalsWithTxStatus
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
router.get('/:userId/pending', requireAuth({ lookup: async (req) => Number(req.params.userId), verifyOwnership: true }), async (req, res) => {
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

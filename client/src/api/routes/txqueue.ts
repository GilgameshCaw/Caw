import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { requireAuth } from '../middleware/auth'

const router = Router()

/**
 * Get status of specific txQueue entries.
 *
 * Auth: the caller's session must include each entry's senderId in
 * authorizedTokenIds. Without this, anyone could enumerate sequential
 * txQueue ids and dump signed-action payloads (incl. recipients,
 * amounts, scheduled tips) for failed entries. Audit fix 2026-05-09
 * (Round 5 API MED-1).
 */
router.get('/status', requireAuth({ anySession: true }), async (req, res) => {
  try {
    const { ids } = req.query

    if (!ids || typeof ids !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid ids parameter' })
    }

    const txQueueIds = ids.split(',').map(id => parseInt(id, 10)).filter(id => !isNaN(id))

    if (txQueueIds.length === 0) {
      return res.status(400).json({ error: 'No valid IDs provided' })
    }

    const authorized = new Set((req.sessionData?.authorizedTokenIds || []) as number[])

    const txQueueEntries = await prisma.txQueue.findMany({
      where: {
        id: { in: txQueueIds }
      },
      select: {
        id: true,
        status: true,
        reason: true,
        senderId: true,
        payload: true,
      }
    })

    res.json({
      statuses: txQueueEntries
        .filter(entry => authorized.has(entry.senderId))
        .map(entry => ({
          id: entry.id,
          status: entry.status,
          reason: entry.reason,
          // Include senderId and payload for failed entries so the client can auto-retry
          ...(entry.status === 'failed' ? { senderId: entry.senderId, payload: entry.payload } : {}),
        }))
    })
  } catch (err: any) {
    console.error('GET /api/txqueue/status error', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

/**
 * Return failed "Cawonce already used" TxQueue entries for a sender
 * (last 24h only). Older entries are escalated to ACTION_FAILED
 * notifications by the DataCleaner.
 */
router.get('/failed-cawonce/:senderId',
  requireAuth({ lookup: async (req) => Number(req.params.senderId) }),
  async (req, res) => {
  try {
    const senderId = parseInt(req.params.senderId, 10)
    if (isNaN(senderId)) {
      return res.status(400).json({ error: 'Invalid senderId' })
    }

    const entries = await prisma.txQueue.findMany({
      where: {
        senderId,
        status: 'failed',
        reason: 'Cawonce already used',
      },
      select: {
        id: true,
        senderId: true,
        payload: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 5,
    })

    // Only return entries from the last 24 hours — older ones are escalated
    // to ACTION_FAILED notifications by the DataCleaner.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const retryable = entries.filter(e => e.updatedAt > cutoff)

    res.json({
      entries: retryable.map(e => ({
        id: e.id,
        senderId: e.senderId,
        payload: e.payload,
      })),
    })
  } catch (err: any) {
    console.error('GET /api/txqueue/failed-cawonce error', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

export default router
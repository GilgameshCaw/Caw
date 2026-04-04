import { Router } from 'express'
import { prisma } from '../../prismaClient'

const router = Router()

/**
 * Get status of specific txQueue entries
 */
router.get('/status', async (req, res) => {
  try {
    const { ids } = req.query

    if (!ids || typeof ids !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid ids parameter' })
    }

    const txQueueIds = ids.split(',').map(id => parseInt(id, 10)).filter(id => !isNaN(id))

    if (txQueueIds.length === 0) {
      return res.status(400).json({ error: 'No valid IDs provided' })
    }

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
      statuses: txQueueEntries.map(entry => ({
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

export default router
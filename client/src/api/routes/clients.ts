import { Router } from 'express'
import { prisma } from '../../prismaClient'

const router = Router()

/**
 * GET /api/clients/:clientId
 * Returns client configuration including replication count
 */
router.get('/:clientId', async (req, res) => {
  try {
    const clientId = parseInt(req.params.clientId, 10)

    if (isNaN(clientId) || clientId < 1) {
      return res.status(400).json({ error: 'Invalid clientId' })
    }

    const client = await prisma.client.findUnique({
      where: { id: clientId }
    })

    if (!client) {
      return res.status(404).json({ error: 'Client not found' })
    }

    // Return client config with replication details
    res.json({
      id: client.id,
      ownerAddress: client.ownerAddress,
      feeAddress: client.feeAddress,
      fees: {
        mint: client.mintFee,
        deposit: client.depositFee,
        withdraw: client.withdrawFee,
        auth: client.authFee
      },
      replication: {
        enabled: client.replicationEnabled,
        chainCount: client.replicationCount,
        destinations: client.replications || []
      },
      lastSyncedAt: client.lastSyncedAt
    })
  } catch (error) {
    console.error('Error fetching client:', error)
    res.status(500).json({ error: 'Failed to fetch client' })
  }
})

/**
 * GET /api/clients
 * Returns all clients (with pagination)
 */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100)
    const offset = parseInt(req.query.offset as string) || 0

    const [clients, total] = await Promise.all([
      prisma.client.findMany({
        take: limit,
        skip: offset,
        orderBy: { id: 'asc' }
      }),
      prisma.client.count()
    ])

    res.json({
      clients: clients.map(client => ({
        id: client.id,
        ownerAddress: client.ownerAddress,
        replicationEnabled: client.replicationEnabled,
        replicationCount: client.replicationCount
      })),
      pagination: {
        total,
        limit,
        offset
      }
    })
  } catch (error) {
    console.error('Error fetching clients:', error)
    res.status(500).json({ error: 'Failed to fetch clients' })
  }
})

export default router

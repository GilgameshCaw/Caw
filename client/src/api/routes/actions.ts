import { Router } from 'express'
import { prisma } from '../../prismaClient'

const router = Router()

/**
 * natstat: enqueue signed actions into TxQueue
 */
router.post('/', async (req, res) => {
  try {
    const { data, domain, types, signature } = req.body
    await prisma.txQueue.create({
      data: {
        senderId: data.senderId,          // ← pull out the on-chain sender
        payload: { data, domain, types },
        signedTx: signature
      }
    })
    res.status(201).json({ status: 'queued' })
  } catch (err: any) {
    console.error('POST /api/actions error', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

export default router



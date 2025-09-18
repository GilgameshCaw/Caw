import { Router } from 'express'
import { prisma } from '../../prismaClient'

const router = Router()

/**
 * natstat: enqueue signed actions into TxQueue
 */
router.post('/', async (req, res) => {
  try {
    const { data, domain, types, signature } = req.body

    // Create optimistic pending like if this is a like action
    if (data.actionType === 'like') {
      try {
        // Find the target caw ID
        const targetCaw = await prisma.caw.findFirst({
          where: {
            userId: data.receiverId,
            cawonce: data.receiverCawonce
          }
        })

        if (targetCaw) {
          // Create pending like (ignore if it already exists)
          await prisma.like.upsert({
            where: {
              userId_cawId: {
                userId: data.senderId,
                cawId: targetCaw.id
              }
            },
            update: {
              pending: true,
              action: 'LIKE'
            },
            create: {
              userId: data.senderId,
              cawId: targetCaw.id,
              action: 'LIKE',
              pending: true
            }
          })
        }
      } catch (likeErr) {
        console.error('Failed to create pending like:', likeErr)
        // Continue even if pending like creation fails
      }
    }

    // Create the transaction queue entry
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



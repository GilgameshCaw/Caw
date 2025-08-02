// src/api/routes/txs.ts
import { Router } from 'express'
import { prisma }  from '../../prismaClient'

const router = Router()

/**
 * GET /api/txs
 * Returns:
 *   { pendingActionIds, actions, users }
 * where
 *   actions: Array<{ id, createdAt, actionType, senderId, receiverId?, recipients?, amounts?, text? }>
 */
router.get('/', async (req, res) => {
  try {
    // 1) fetch pending queue entries
    const raws = await prisma.txQueue.findMany({
      where: { senderId: Number(req.query.senderId) },
      orderBy: { createdAt: 'desc' },
      take: 100
    })

    // 2) ids + raw action-data + createdAt
    const pendingActionIds = raws.map(r => r.id)
    const actions = raws.map(r => ({
      id:         r.id,
      createdAt:  r.createdAt,
      status: r.status,
      ...(r.payload as any).data
    }))

    // 3) collect all userIds referenced
    const userIdSet = new Set<number>()
    for (const a of actions) {
      userIdSet.add(a.senderId)
      if (a.receiverId)    userIdSet.add(a.receiverId)
      if (Array.isArray(a.recipients)) {
        a.recipients.forEach((id: number) => userIdSet.add(id))
      }
    }
    const userIds = Array.from(userIdSet)

    // 4) bulk-load those users
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, username: true, address: true }
    })

    // 5) send combined JSON
    res.json({ pendingActionIds, actions, users })
  } catch (err:any) {
    console.error('GET /api/txs', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

export default router


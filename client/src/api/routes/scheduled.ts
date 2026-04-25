import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { requireAuth } from '../middleware/auth'

const router = Router()

/**
 * GET /api/scheduled
 * Get scheduled caws for the authenticated user
 */
router.get('/', requireAuth({ lookup: (req) => Promise.resolve(Number(req.header('x-user-id')) || undefined) }), async (req, res) => {
  try {
    const userId = req.header('x-user-id') ? parseInt(req.header('x-user-id')!) : null

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' })
    }

    const status = req.query.status as string || 'pending'
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
    const offset = parseInt(req.query.offset as string) || 0

    const scheduled = await prisma.scheduledCaw.findMany({
      where: {
        userId,
        status
      },
      orderBy: { scheduledAt: 'asc' },
      take: limit,
      skip: offset,
      include: {
        user: true
      }
    })

    return res.json({
      items: scheduled,
      nextCursor: scheduled.length === limit ? offset + limit : undefined
    })
  } catch (error) {
    console.error('GET /api/scheduled error:', error)
    return res.status(500).json({ error: 'Failed to fetch scheduled caws' })
  }
})

/**
 * POST /api/scheduled
 * Create a scheduled caw — either a single post (existing payload shape) or a
 * thread of N pre-signed chunks (new `chunks` array shape).
 *
 * Single-post body:   { content, scheduledAt, imageData?, signedAction }
 * Thread body:        { scheduledAt, chunks: [{ content, imageData?, signedAction }, ...] }
 *
 * For threads, every chunk shares one scheduledAt and a generated threadId; the
 * processor publishes them in threadIndex order so chunk N's reply target
 * (chunk N-1) exists by the time it's processed.
 */
router.post('/', requireAuth({ lookup: (req) => Promise.resolve(Number(req.header('x-user-id')) || undefined) }), async (req, res) => {
  try {
    const userId = req.header('x-user-id') ? parseInt(req.header('x-user-id')!) : null

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' })
    }

    const { content, scheduledAt, imageData, signedAction, chunks } = req.body

    if (!scheduledAt) {
      return res.status(400).json({ error: 'Scheduled time is required' })
    }
    const scheduledDate = new Date(scheduledAt)
    if (scheduledDate <= new Date()) {
      return res.status(400).json({ error: 'Scheduled time must be in the future' })
    }

    // Thread path: chunks is a non-empty array
    if (Array.isArray(chunks) && chunks.length > 0) {
      // Validate every chunk has its own signed action with a cawonce
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]
        if (!c?.content) return res.status(400).json({ error: `Chunk ${i} missing content` })
        if (!c?.signedAction?.signature) return res.status(400).json({ error: `Chunk ${i} missing signature` })
        if (c?.signedAction?.data?.cawonce === undefined || c.signedAction.data.cawonce === null) {
          return res.status(400).json({ error: `Chunk ${i} missing cawonce` })
        }
      }
      // Generate a thread id once; reuse for every chunk so the processor and UI can group them
      const threadId = `t_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const total = chunks.length
      // Interactive form so all chunks share one transaction. The array form
      // of $transaction was rejecting our mapped promises with "All elements
      // of the array need to be Prisma Client promises" — likely a wrapper
      // type-tag issue. Sequential creates inside an interactive tx work cleanly.
      const created = await prisma.$transaction(async (tx) => {
        const rows = []
        for (let i = 0; i < chunks.length; i++) {
          const c: any = chunks[i]
          rows.push(await tx.scheduledCaw.create({
            data: {
              userId,
              content: c.content,
              scheduledAt: scheduledDate,
              imageData: c.imageData,
              hasImage: !!c.imageData,
              signedAction: c.signedAction as any,
              cawonce: c.signedAction.data.cawonce,
              threadId,
              threadIndex: i,
              threadTotal: total,
            },
          }))
        }
        return rows
      })
      return res.json({ thread: true, threadId, items: created })
    }

    // Single-post path (back-compat)
    if (!content) return res.status(400).json({ error: 'Content is required' })
    if (!signedAction?.signature) return res.status(400).json({ error: 'Signed action data is required' })
    const cawonce = signedAction.data?.cawonce
    if (cawonce === undefined || cawonce === null) {
      return res.status(400).json({ error: 'Signed action must include cawonce' })
    }

    const scheduled = await prisma.scheduledCaw.create({
      data: {
        userId,
        content,
        scheduledAt: scheduledDate,
        imageData,
        hasImage: !!imageData,
        signedAction: signedAction as any,
        cawonce,
      },
      include: { user: true },
    })

    return res.json(scheduled)
  } catch (error) {
    console.error('POST /api/scheduled error:', error)
    return res.status(500).json({ error: 'Failed to create scheduled caw' })
  }
})

/**
 * PUT /api/scheduled/:id
 * Update a scheduled caw
 */
router.put('/:id', requireAuth({ lookup: (req) => Promise.resolve(Number(req.header('x-user-id')) || undefined) }), async (req, res) => {
  try {
    const userId = req.header('x-user-id') ? parseInt(req.header('x-user-id')!) : null
    const id = parseInt(req.params.id)

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' })
    }

    if (!id || isNaN(id)) {
      return res.status(400).json({ error: 'Invalid scheduled caw ID' })
    }

    const { content, scheduledAt, imageData } = req.body

    // Check ownership
    const existing = await prisma.scheduledCaw.findFirst({
      where: { id, userId }
    })

    if (!existing) {
      return res.status(404).json({ error: 'Scheduled caw not found' })
    }

    if (existing.status !== 'pending') {
      return res.status(400).json({ error: 'Cannot update non-pending scheduled caw' })
    }

    // Validate scheduled time if provided
    if (scheduledAt) {
      const scheduledDate = new Date(scheduledAt)
      if (scheduledDate <= new Date()) {
        return res.status(400).json({ error: 'Scheduled time must be in the future' })
      }
    }

    const updated = await prisma.scheduledCaw.update({
      where: { id },
      data: {
        content: content || existing.content,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : existing.scheduledAt,
        imageData: imageData !== undefined ? imageData : existing.imageData,
        hasImage: imageData !== undefined ? !!imageData : existing.hasImage
      },
      include: {
        user: true
      }
    })

    return res.json(updated)
  } catch (error) {
    console.error('PUT /api/scheduled/:id error:', error)
    return res.status(500).json({ error: 'Failed to update scheduled caw' })
  }
})

/**
 * DELETE /api/scheduled/:id
 * Cancel a scheduled caw
 */
router.delete('/:id', requireAuth({ lookup: (req) => Promise.resolve(Number(req.header('x-user-id')) || undefined) }), async (req, res) => {
  try {
    const userId = req.header('x-user-id') ? parseInt(req.header('x-user-id')!) : null
    const id = parseInt(req.params.id)

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' })
    }

    if (!id || isNaN(id)) {
      return res.status(400).json({ error: 'Invalid scheduled caw ID' })
    }

    // Check ownership
    const existing = await prisma.scheduledCaw.findFirst({
      where: { id, userId }
    })

    if (!existing) {
      return res.status(404).json({ error: 'Scheduled caw not found' })
    }

    if (existing.status !== 'pending') {
      return res.status(400).json({ error: 'Cannot cancel non-pending scheduled caw' })
    }

    // Cancelling any chunk of a thread cancels every still-pending chunk —
    // half-publishing a thread would orphan the tail.
    if (existing.threadId) {
      await prisma.scheduledCaw.updateMany({
        where: { threadId: existing.threadId, userId, status: 'pending' },
        data: { status: 'cancelled' },
      })
    } else {
      await prisma.scheduledCaw.update({
        where: { id },
        data: { status: 'cancelled' },
      })
    }

    return res.json({ success: true })
  } catch (error) {
    console.error('DELETE /api/scheduled/:id error:', error)
    return res.status(500).json({ error: 'Failed to cancel scheduled caw' })
  }
})

export default router
import { Router } from 'express'
import { prisma } from '../../prismaClient'

const router = Router()

/**
 * GET /api/scheduled
 * Get scheduled caws for the authenticated user
 */
router.get('/', async (req, res) => {
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
 * Create a new scheduled caw with signed action data
 */
router.post('/', async (req, res) => {
  try {
    const userId = req.header('x-user-id') ? parseInt(req.header('x-user-id')!) : null

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' })
    }

    const { content, scheduledAt, imageData, signedAction } = req.body

    if (!content || !scheduledAt) {
      return res.status(400).json({ error: 'Content and scheduled time are required' })
    }

    if (!signedAction || !signedAction.signature) {
      return res.status(400).json({ error: 'Signed action data is required' })
    }

    // Validate scheduled time is in the future
    const scheduledDate = new Date(scheduledAt)
    if (scheduledDate <= new Date()) {
      return res.status(400).json({ error: 'Scheduled time must be in the future' })
    }

    // Extract cawonce from the signed action data
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
        // Store the signed action for later processing
        signedAction: signedAction as any,
        cawonce: cawonce // Store cawonce separately for collision detection
      },
      include: {
        user: true
      }
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
router.put('/:id', async (req, res) => {
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
router.delete('/:id', async (req, res) => {
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

    // Update status to cancelled instead of deleting
    await prisma.scheduledCaw.update({
      where: { id },
      data: { status: 'cancelled' }
    })

    return res.json({ success: true })
  } catch (error) {
    console.error('DELETE /api/scheduled/:id error:', error)
    return res.status(500).json({ error: 'Failed to cancel scheduled caw' })
  }
})

export default router
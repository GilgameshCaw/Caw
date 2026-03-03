import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { CawStatus } from '@prisma/client'

const router = Router()

/**
 * POST /api/on-chain-images
 * Create or update an on-chain image record
 * Uses upsert to handle race conditions with ActionProcessor
 */
router.post('/', async (req, res) => {
  try {
    const { userId, txQueueId, imageRef, cawonce, base64Data, cawCost } = req.body

    console.log('[OnChainImages] POST received:', { userId, txQueueId, imageRef, cawonce, cawCost, hasBase64: !!base64Data })

    if (!userId || !imageRef || cawonce === undefined || !base64Data || !cawCost) {
      return res.status(400).json({
        error: 'Missing required fields: userId, imageRef, cawonce, base64Data, cawCost'
      })
    }

    // Use upsert to handle race condition where ActionProcessor may have created the record first
    const image = await prisma.onChainImage.upsert({
      where: { imageRef },
      update: {
        // If record exists (created by ActionProcessor), add the txQueueId for polling
        // Use null check instead of || to handle txQueueId of 0
        txQueueId: txQueueId != null ? txQueueId : undefined
      },
      create: {
        userId,
        txQueueId,
        imageRef,
        cawonce,
        base64Data,
        cawCost,
        status: CawStatus.PENDING
      }
    })

    return res.status(201).json(image)
  } catch (err: any) {
    console.error('POST /api/on-chain-images error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/on-chain-images
 * Get paginated list of on-chain images for a user
 */
router.get('/', async (req, res) => {
  try {
    const userId = Number(req.query.userId || req.header('x-user-id'))
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50)
    const cursor = req.query.cursor ? Number(req.query.cursor) : undefined
    const status = req.query.status as string | undefined

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' })
    }

    const where: any = { userId }

    // Filter by status if provided
    if (status) {
      if (!['PENDING', 'SUCCESS', 'FAILED'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status. Must be PENDING, SUCCESS, or FAILED' })
      }
      where.status = status as CawStatus
    }

    const images = await prisma.onChainImage.findMany({
      where,
      take: limit + 1,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        imageRef: true,
        cawonce: true,
        base64Data: true,
        status: true,
        cawCost: true,
        reason: true,
        postedAt: true,
        ignored: true,
        createdAt: true
      }
    })

    const hasMore = images.length > limit
    const items = images.slice(0, limit)
    const nextCursor = hasMore ? items[items.length - 1].id : undefined

    return res.json({
      items,
      nextCursor,
      hasMore
    })
  } catch (err: any) {
    console.error('GET /api/on-chain-images error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/on-chain-images/unposted-count/:userId
 * Get count of unposted (not used in any post and not ignored) images for a user
 * NOTE: This route must be defined BEFORE /:id to avoid route conflicts
 */
router.get('/unposted-count/:userId', async (req, res) => {
  try {
    const userId = Number(req.params.userId)

    if (!userId || isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid userId' })
    }

    const count = await prisma.onChainImage.count({
      where: {
        userId,
        status: CawStatus.SUCCESS,
        postedAt: null,
        ignored: false
      }
    })

    // Also get total successful images count for showing the icon
    const totalCount = await prisma.onChainImage.count({
      where: {
        userId,
        status: CawStatus.SUCCESS
      }
    })

    return res.json({ unpostedCount: count, totalCount })
  } catch (err: any) {
    console.error('GET /api/on-chain-images/unposted-count/:userId error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/on-chain-images/status?txId=123
 * Get image status by txQueueId
 * NOTE: This route must be defined BEFORE /:id to avoid route conflicts
 */
router.get('/status', async (req, res) => {
  console.log('[DEBUG] /status route hit, query:', req.query)
  try {
    const txQueueId = Number(req.query.txId)

    if (!txQueueId || isNaN(txQueueId)) {
      return res.status(400).json({ error: 'Invalid txId query parameter' })
    }

    const image = await prisma.onChainImage.findFirst({
      where: { txQueueId },
      select: {
        id: true,
        imageRef: true,
        status: true,
        reason: true
      }
    })

    if (!image) {
      return res.status(404).json({ error: 'Image not found' })
    }

    return res.json(image)
  } catch (err: any) {
    console.error('GET /api/on-chain-images/status error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/on-chain-images/:id
 * Get a single on-chain image by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)

    if (!id || isNaN(id)) {
      return res.status(400).json({ error: 'Invalid image ID' })
    }

    const image = await prisma.onChainImage.findUnique({
      where: { id }
    })

    if (!image) {
      return res.status(404).json({ error: 'Image not found' })
    }

    return res.json(image)
  } catch (err: any) {
    console.error('GET /api/on-chain-images/:id error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/on-chain-images/ref/:ref
 * Get a single on-chain image by its reference (img:senderId:cawonce)
 */
router.get('/ref/:ref', async (req, res) => {
  try {
    const { ref } = req.params

    if (!ref) {
      return res.status(400).json({ error: 'Image reference is required' })
    }

    const image = await prisma.onChainImage.findUnique({
      where: { imageRef: ref }
    })

    if (!image) {
      return res.status(404).json({ error: 'Image not found' })
    }

    return res.json(image)
  } catch (err: any) {
    console.error('GET /api/on-chain-images/ref/:ref error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * PATCH /api/on-chain-images/:id/status
 * Update the status of an on-chain image (used by ValidatorService)
 */
router.patch('/:id/status', async (req, res) => {
  try {
    const id = Number(req.params.id)
    const { status, reason } = req.body

    if (!id || isNaN(id)) {
      return res.status(400).json({ error: 'Invalid image ID' })
    }

    if (!status || !['PENDING', 'SUCCESS', 'FAILED'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be PENDING, SUCCESS, or FAILED' })
    }

    const image = await prisma.onChainImage.update({
      where: { id },
      data: {
        status: status as CawStatus,
        reason: status === 'FAILED' ? reason : null
      }
    })

    return res.json(image)
  } catch (err: any) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Image not found' })
    }
    console.error('PATCH /api/on-chain-images/:id/status error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * PATCH /api/on-chain-images/:id/ignore
 * Mark an image as ignored (dismiss the "not posted" badge)
 */
router.patch('/:id/ignore', async (req, res) => {
  try {
    const id = Number(req.params.id)
    const { ignored } = req.body

    if (!id || isNaN(id)) {
      return res.status(400).json({ error: 'Invalid image ID' })
    }

    const image = await prisma.onChainImage.update({
      where: { id },
      data: { ignored: ignored !== false } // Default to true if not specified
    })

    return res.json(image)
  } catch (err: any) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Image not found' })
    }
    console.error('PATCH /api/on-chain-images/:id/ignore error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * PATCH /api/on-chain-images/mark-posted
 * Mark images as posted when used in a caw
 */
router.patch('/mark-posted', async (req, res) => {
  try {
    const { imageRefs } = req.body

    if (!imageRefs || !Array.isArray(imageRefs) || imageRefs.length === 0) {
      return res.status(400).json({ error: 'imageRefs array is required' })
    }

    const result = await prisma.onChainImage.updateMany({
      where: {
        imageRef: { in: imageRefs },
        postedAt: null // Only update if not already posted
      },
      data: {
        postedAt: new Date()
      }
    })

    return res.json({ updated: result.count })
  } catch (err: any) {
    console.error('PATCH /api/on-chain-images/mark-posted error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router

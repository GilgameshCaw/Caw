import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { ReportReason, ReportStatus } from '@prisma/client'

const router = Router()

/**
 * POST /api/reports
 * Submit a new report for a post
 */
router.post('/', async (req, res) => {
  try {
    const { reporterId, postId, postAuthorId, reason, details } = req.body

    // Validate required fields
    if (!postId || !postAuthorId || !reason) {
      return res.status(400).json({ error: 'postId, postAuthorId, and reason are required' })
    }

    // Validate reason is a valid enum value
    if (!Object.values(ReportReason).includes(reason)) {
      return res.status(400).json({
        error: 'Invalid reason. Must be one of: SPAM, HARASSMENT, INAPPROPRIATE, MISINFORMATION, OTHER'
      })
    }

    // Check if this post has already been reported by this user (if reporterId provided)
    if (reporterId) {
      const existingReport = await prisma.report.findFirst({
        where: {
          reporterId: parseInt(reporterId),
          postId: parseInt(postId)
        }
      })

      if (existingReport) {
        return res.status(409).json({ error: 'You have already reported this post' })
      }
    }

    // Create the report
    const report = await prisma.report.create({
      data: {
        reporterId: reporterId ? parseInt(reporterId) : 0, // 0 for anonymous reports
        postId: parseInt(postId),
        postAuthorId: parseInt(postAuthorId),
        reason: reason as ReportReason,
        details: details || null,
        status: ReportStatus.PENDING
      }
    })

    return res.status(201).json({
      success: true,
      reportId: report.id,
      message: 'Report submitted successfully'
    })
  } catch (error) {
    console.error('POST /api/reports error:', error)
    return res.status(500).json({ error: 'Failed to submit report' })
  }
})

/**
 * GET /api/reports
 * Get reports (admin only - should add auth middleware)
 */
router.get('/', async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query

    const where: any = {}
    if (status && Object.values(ReportStatus).includes(status as ReportStatus)) {
      where.status = status as ReportStatus
    }

    const reports = await prisma.report.findMany({
      where,
      take: Math.min(Number(limit), 100),
      skip: Number(offset),
      orderBy: { createdAt: 'desc' }
    })

    const total = await prisma.report.count({ where })

    return res.json({ reports, total })
  } catch (error) {
    console.error('GET /api/reports error:', error)
    return res.status(500).json({ error: 'Failed to fetch reports' })
  }
})

/**
 * PATCH /api/reports/:id
 * Update report status (admin only - should add auth middleware)
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { status, resolution, reviewedBy } = req.body

    if (!status || !Object.values(ReportStatus).includes(status)) {
      return res.status(400).json({ error: 'Valid status is required' })
    }

    const report = await prisma.report.update({
      where: { id: parseInt(id) },
      data: {
        status: status as ReportStatus,
        resolution: resolution || null,
        reviewedBy: reviewedBy || null,
        reviewedAt: new Date()
      }
    })

    return res.json({ success: true, report })
  } catch (error) {
    console.error('PATCH /api/reports/:id error:', error)
    return res.status(500).json({ error: 'Failed to update report' })
  }
})

export default router

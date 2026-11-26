import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { ReportReason, ReportStatus } from '@prisma/client'
import { requireAuth, requireModerator } from '../middleware/auth'
import { submitPostReport } from '../shared/reportSubmit'

const router = Router()

/**
 * POST /api/reports
 * Submit a new report for a post
 */
router.post('/', requireAuth({ field: 'reporterId', verifyOwnership: true }), async (req, res) => {
  try {
    // postAuthorId is not read: the author is taken from the post itself. Clients
    // that still send it are not refused.
    const { postId, reason, details } = req.body

    // Validate required fields
    if (!postId || !reason) {
      return res.status(400).json({ error: 'postId and reason are required' })
    }

    // Validate reason is a valid enum value
    if (!Object.values(ReportReason).includes(reason)) {
      return res.status(400).json({
        error: 'Invalid reason. Must be one of: SPAM, HARASSMENT, INAPPROPRIATE, MISINFORMATION, OTHER'
      })
    }

    // The reporter is the id requireAuth checked against the session, read the way
    // it reads it (Number(), from the body or else the query). parseInt would read
    // "9.90202e5" as 9 while requireAuth took it as 990202, and a report from the
    // query would have had no reporter at all.
    const reporterId = Number(req.body?.reporterId ?? req.query?.reporterId)
    const result = await submitPostReport(prisma, {
      reporterId,
      postId,
      reason: reason as ReportReason,
      details,
    })
    return res.status(result.status).json(result.body)
  } catch (error) {
    console.error('POST /api/reports error:', error)
    return res.status(500).json({ error: 'Failed to submit report' })
  }
})

/**
 * GET /api/reports
 * Get reports (admin only)
 */
router.get('/', requireModerator, async (req, res) => {
  try {
    const { status, reason, limit = 50, offset = 0 } = req.query

    const where: any = {}
    if (status && Object.values(ReportStatus).includes(status as ReportStatus)) {
      where.status = status as ReportStatus
    }
    if (reason && Object.values(ReportReason).includes(reason as ReportReason)) {
      where.reason = reason as ReportReason
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
 * Update report status (admin only)
 */
router.patch('/:id', requireModerator, async (req, res) => {
  try {
    const { id } = req.params
    const { status, resolution } = req.body
    // reviewedBy is intentionally NOT taken from req.body — any moderator
    // could otherwise falsify audit attribution. Derive from the session
    // identity that passed requireModerator. (M-2 audit fix 2026-05-23.)
    const reviewedBy = req.moderatorActorTokenId ?? null

    if (!status || !Object.values(ReportStatus).includes(status)) {
      return res.status(400).json({ error: 'Valid status is required' })
    }

    const report = await prisma.report.update({
      where: { id: parseInt(id) },
      data: {
        status: status as ReportStatus,
        resolution: resolution || null,
        reviewedBy: reviewedBy !== null ? String(reviewedBy) : null,
        reviewedAt: new Date()
      }
    })

    return res.json({ success: true, report })
  } catch (error) {
    console.error('PATCH /api/reports/:id error:', error)
    return res.status(500).json({ error: 'Failed to update report' })
  }
})

/**
 * POST /api/reports/user
 * Submit a report against a user (e.g. from DMs)
 */
router.post('/user', requireAuth({ field: 'reporterId', verifyOwnership: true }), async (req, res) => {
  try {
    const { reporterId, reportedUserId, reportedUsername, reason, details, imageUrls } = req.body

    if (!reportedUserId || !reason) {
      return res.status(400).json({ error: 'reportedUserId and reason are required' })
    }

    if (!Object.values(ReportReason).includes(reason)) {
      return res.status(400).json({ error: 'Invalid reason' })
    }

    // Check for duplicate report
    const existing = await prisma.report.findFirst({
      where: {
        reporterId: parseInt(reporterId || '0'),
        postAuthorId: parseInt(reportedUserId),
        postId: 0, // 0 indicates a user report (not a specific post)
      }
    })

    if (existing) {
      return res.status(409).json({ error: 'You have already reported this user' })
    }

    const report = await prisma.report.create({
      data: {
        reporterId: reporterId ? parseInt(reporterId) : 0,
        postId: 0, // 0 = user report
        postAuthorId: parseInt(reportedUserId),
        reason: reason as ReportReason,
        details: [
          details || '',
          reportedUsername ? `Reported user: @${reportedUsername}` : '',
          imageUrls?.length ? `Evidence: ${imageUrls.join(' | ')}` : '',
        ].filter(Boolean).join('\n'),
        status: ReportStatus.PENDING,
      }
    })

    return res.status(201).json({ success: true, reportId: report.id })
  } catch (error) {
    console.error('POST /api/reports/user error:', error)
    return res.status(500).json({ error: 'Failed to submit report' })
  }
})

export default router

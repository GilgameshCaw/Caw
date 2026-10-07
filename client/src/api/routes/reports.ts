import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { ReportReason, ReportStatus } from '@prisma/client'
import { requireAuth, requireModerator } from '../middleware/auth'

const router = Router()

/**
 * POST /api/reports
 * Submit a new report for a post
 */
router.post('/', requireAuth({ field: 'reporterId', verifyOwnership: true }), async (req, res) => {
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

    // If user already reported this post, update their existing report
    if (reporterId) {
      const existingReport = await prisma.report.findFirst({
        where: {
          reporterId: parseInt(reporterId),
          postId: parseInt(postId)
        }
      })

      if (existingReport) {
        const updated = await prisma.report.update({
          where: { id: existingReport.id },
          data: {
            reason: reason as ReportReason,
            details: details || null,
            status: ReportStatus.PENDING,
            reviewedAt: null,
            reviewedBy: null,
            resolution: null,
          }
        })

        return res.status(200).json({
          success: true,
          reportId: updated.id,
          message: 'Report updated'
        })
      }
    }

    // Create the report. reporterId is guaranteed non-falsy by requireAuth
    // above — it validates req.body.reporterId against the authenticated
    // session and returns 400 / 401 / 403 if it's missing or doesn't match.
    // The previous `: 0` fallback was dead code that, if reached, would have
    // de-anonymized... or rather, falsely anonymized... the report.
    const report = await prisma.report.create({
      data: {
        reporterId: parseInt(reporterId),
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

    // Context for the moderator list: usernames for reporter / author and a
    // short excerpt of the reported post. Two batched queries per page, no
    // per-row lookups. Existing fields are unchanged; these are extra fields.
    // Post content is only returned for SUCCESS posts: a HIDDEN post was
    // suppressed by its author (GET /api/caws/:id returns 410 for it), FAILED
    // is creator-only there, and PENDING is not confirmed yet.
    // tokenId 0 is a real tokenId, so user ids are looked up with >= 0; only
    // postId 0 is a sentinel (user report).
    const postIds = new Set<number>()
    for (const r of reports) {
      if (r.postId > 0) postIds.add(r.postId)
    }
    const cawById = new Map<number, { userId: number; status: string; content: string }>()
    if (postIds.size > 0) {
      const caws = await prisma.caw.findMany({
        where: { id: { in: Array.from(postIds) } },
        select: { id: true, userId: true, status: true, content: true },
      })
      for (const c of caws) cawById.set(c.id, { userId: c.userId, status: c.status, content: c.content })
    }
    // Report.postAuthorId is whatever the reporter sent (POST /api/reports does
    // not check it against the post), so for a report on an existing post the
    // author shown here is the post's real author, taken from the Caw row.
    // User reports (postId 0) and posts that no longer exist keep the stored id.
    const actualAuthorOf = (r: { postId: number; postAuthorId: number }) => {
      const caw = r.postId > 0 ? cawById.get(r.postId) : undefined
      return caw ? caw.userId : r.postAuthorId
    }
    const userIds = new Set<number>()
    for (const r of reports) {
      if (r.reporterId >= 0) userIds.add(r.reporterId)
      if (r.postAuthorId >= 0) userIds.add(r.postAuthorId)
      const actual = actualAuthorOf(r)
      if (actual >= 0) userIds.add(actual)
    }
    const usernameByTokenId = new Map<number, string>()
    if (userIds.size > 0) {
      const users = await prisma.user.findMany({
        where: { tokenId: { in: Array.from(userIds) } },
        select: { tokenId: true, username: true },
      })
      for (const u of users) usernameByTokenId.set(u.tokenId, u.username)
    }
    const excerpt = (content: string) => {
      const chars = Array.from(content)
      return chars.length > 200 ? chars.slice(0, 200).join('') + '...' : content
    }
    const enriched = reports.map(r => {
      const caw = r.postId > 0 ? cawById.get(r.postId) : undefined
      const actualAuthorId = actualAuthorOf(r)
      return {
        ...r,
        reporterIdUsername: usernameByTokenId.get(r.reporterId) ?? null,
        postAuthorIdUsername: usernameByTokenId.get(actualAuthorId) ?? null,
        postActualAuthorId: actualAuthorId,
        postAuthorMismatch: actualAuthorId !== r.postAuthorId,
        postStatus: caw?.status ?? null,
        postContent: caw && caw.status === 'SUCCESS' ? excerpt(caw.content) : null,
      }
    })

    return res.json({ reports: enriched, total })
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

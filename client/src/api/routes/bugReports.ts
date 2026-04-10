import { Router } from 'express'
import { prisma } from '../../prismaClient'
import {
  requireAdmin,
  loginAdmin,
  revokeAdminToken,
  extractAdminToken,
  adminCookieOptions,
  ADMIN_COOKIE_NAME,
} from '../middleware/auth'

const router = Router()

/**
 * POST /api/bug-reports/login
 * Authenticate with password. Sets an HttpOnly admin session cookie.
 * The response body no longer contains the token — it lives only in the cookie
 * so JS (and any XSS) can't read it.
 */
router.post('/login', (req, res): void => {
  const { password } = req.body
  const result = loginAdmin(password)
  if (!result) {
    res.status(401).json({ error: 'Invalid password' })
    return
  }

  res.cookie(ADMIN_COOKIE_NAME, result.token, adminCookieOptions())
  res.json({ ok: true, expiresAt: result.expiresAt })
})

/**
 * POST /api/bug-reports/logout
 * Revoke the current admin session and clear the cookie.
 */
router.post('/logout', (req, res): void => {
  const token = extractAdminToken(req)
  revokeAdminToken(token)
  res.clearCookie(ADMIN_COOKIE_NAME, { path: '/' })
  res.json({ ok: true })
})

/**
 * GET /api/bug-reports/me
 * Lightweight check used by the frontend AdminGate to verify the current
 * cookie is still valid without hitting a real admin endpoint.
 */
router.get('/me', requireAdmin, (_req, res): void => {
  res.json({ ok: true })
})

/**
 * POST /api/bug-reports
 * Submit a bug report (no auth required)
 */
router.post('/', async (req, res): Promise<void> => {
  try {
    const { type, userId, username, stakedAmount, description, imageUrls, page, userAgent } = req.body

    if (!description || !description.trim()) {
      res.status(400).json({ error: 'Description is required' })
      return
    }

    const reportType = type === 'feature' ? 'feature' : 'bug'

    const report = await prisma.bugReport.create({
      data: {
        type: reportType,
        userId: userId || null,
        username: username || null,
        stakedAmount: stakedAmount || null,
        description: description.trim(),
        imageUrls: imageUrls || null,
        page: page || null,
        userAgent: userAgent || null
      }
    })

    res.json({ success: true, id: report.id })
  } catch (err) {
    console.error('[BugReports] Failed to create bug report:', err)
    res.status(500).json({ error: 'Failed to submit bug report' })
  }
})

/**
 * GET /api/bug-reports
 * List bug reports (admin only)
 */
router.get('/', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status as string | undefined
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100)
    const offset = parseInt(req.query.offset as string) || 0

    const where: any = {}
    if (status) where.status = status

    const [reports, total] = await Promise.all([
      prisma.bugReport.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset
      }),
      prisma.bugReport.count({ where })
    ])

    res.json({ reports, total, limit, offset })
  } catch (err) {
    console.error('[BugReports] Failed to fetch bug reports:', err)
    res.status(500).json({ error: 'Failed to fetch bug reports' })
  }
})

/**
 * PATCH /api/bug-reports/:id
 * Update a bug report status (admin only)
 */
router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const { status, resolution } = req.body

    const report = await prisma.bugReport.update({
      where: { id },
      data: {
        status,
        resolution: resolution || null,
        reviewedAt: new Date()
      }
    })

    res.json({ success: true, report })
  } catch (err) {
    console.error('[BugReports] Failed to update bug report:', err)
    res.status(500).json({ error: 'Failed to update bug report' })
  }
})

export default router

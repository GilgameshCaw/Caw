import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { requireAdmin, loginAdmin } from '../middleware/auth'

const router = Router()

/**
 * POST /api/bug-reports/login
 * Authenticate with password, receive a bearer token
 */
router.post('/login', (req, res): void => {
  const { password } = req.body
  const token = loginAdmin(password)
  if (!token) {
    res.status(401).json({ error: 'Invalid password' })
    return
  }

  res.json({ token })
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

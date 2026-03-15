import { Router, Request, Response, NextFunction } from 'express'
import { randomBytes } from 'crypto'
import { prisma } from '../../prismaClient'

const router = Router()

const ADMIN_PASSWORD = process.env.BUG_REPORT_ADMIN_PASSWORD || 'caw-admin-2026'

// In-memory token store (cleared on server restart, which is fine for admin sessions)
const validTokens = new Map<string, number>() // token -> expiry timestamp
const TOKEN_TTL = 24 * 60 * 60 * 1000 // 24 hours

function generateToken(): string {
  return randomBytes(32).toString('hex')
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const token = authHeader.slice(7)
  const expiry = validTokens.get(token)
  if (!expiry || Date.now() > expiry) {
    validTokens.delete(token)
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  next()
}

/**
 * POST /api/bug-reports/login
 * Authenticate with password, receive a bearer token
 */
router.post('/login', (req, res): void => {
  const { password } = req.body
  if (password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Invalid password' })
    return
  }

  const token = generateToken()
  validTokens.set(token, Date.now() + TOKEN_TTL)

  res.json({ token })
})

/**
 * POST /api/bug-reports
 * Submit a bug report (no auth required)
 */
router.post('/', async (req, res): Promise<void> => {
  try {
    const { userId, username, stakedAmount, description, imageUrls, page, userAgent } = req.body

    if (!description || !description.trim()) {
      res.status(400).json({ error: 'Description is required' })
      return
    }

    const report = await prisma.bugReport.create({
      data: {
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

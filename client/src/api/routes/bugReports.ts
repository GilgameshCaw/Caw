import { Router } from 'express'
import { prisma } from '../../prismaClient'
import {
  requireModerator,
  extractSession,
} from '../middleware/auth'
import Redis from 'ioredis'

const router = Router()
const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : new Redis({ port: 6379, host: '127.0.0.1' })

// Per-IP throttle for the unauthenticated POST /api/bug-reports endpoint.
// Prevents anonymous spam + impersonation flood. Authenticated reports
// from a session reuse the same bucket but get a higher cap.
const REPORT_IP_LIMIT_ANON = 5     // per hour, no session
const REPORT_IP_LIMIT_AUTH = 30    // per hour, with session
const REPORT_WINDOW = 60 * 60

async function checkReportRate(ip: string, hasSession: boolean): Promise<boolean> {
  const k = `bugreport_ratelimit:${ip}`
  const max = hasSession ? REPORT_IP_LIMIT_AUTH : REPORT_IP_LIMIT_ANON
  const count = await redis.llen(k)
  if (count >= max) return false
  await redis.rpush(k, Date.now().toString())
  await redis.expire(k, REPORT_WINDOW)
  return true
}

/**
 * POST /api/bug-reports
 * Submit a bug report (no auth required)
 */
router.post('/', async (req, res): Promise<void> => {
  try {
    const { type, stakedAmount, description, imageUrls, page, userAgent } = req.body

    if (!description || typeof description !== 'string' || !description.trim()) {
      res.status(400).json({ error: 'Description is required' })
      return
    }

    // Identity is derived from the session, NOT request body — prevents
    // moderator-side impersonation of arbitrary users in the report queue.
    // Audit fix 2026-05-09 (Round 5 API MED-2).
    await extractSession(req)
    const sessionTokenIds = (req.sessionData?.authorizedTokenIds || []) as number[]
    const userId = sessionTokenIds.length > 0 ? sessionTokenIds[0] : null
    let username: string | null = null
    if (userId !== null) {
      const u = await prisma.user.findUnique({ where: { tokenId: userId }, select: { username: true } })
      username = u?.username ?? null
    }

    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
      || req.socket?.remoteAddress
      || 'unknown'
    if (!(await checkReportRate(ip, userId !== null))) {
      res.status(429).json({ error: 'Rate limit exceeded — please try again later' })
      return
    }

    const reportType = type === 'feature' ? 'feature' : 'bug'

    const trimmedDescription = description.trim().slice(0, 5000)

    const report = await prisma.bugReport.create({
      data: {
        type: reportType,
        userId,
        username,
        stakedAmount: typeof stakedAmount === 'string' ? stakedAmount : null,
        description: trimmedDescription,
        imageUrls: typeof imageUrls === 'string' ? imageUrls : null,
        page: typeof page === 'string' ? page.slice(0, 500) : null,
        userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 500) : null
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
router.get('/', requireModerator, async (req, res) => {
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

const VALID_BUG_REPORT_STATUSES = ['PENDING', 'REVIEWED', 'ACTIONED', 'DISMISSED'] as const

/**
 * PATCH /api/bug-reports/:id
 * Update a bug report status (admin only)
 */
router.patch('/:id', requireModerator, async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const { status, resolution } = req.body

    if (status !== undefined && !VALID_BUG_REPORT_STATUSES.includes(status)) {
      res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_BUG_REPORT_STATUSES.join(', ')}` })
      return
    }

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

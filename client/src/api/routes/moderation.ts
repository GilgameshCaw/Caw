// /api/moderation/* — actions performed by moderators (or admins).
//
// Every mutation here writes a ModeratorAction row so admins can audit
// "who hid which caw, when, why" without grep-archaeology of server
// logs. The actor is whichever wallet-bound tokenId holds the role
// (req.moderatorActorTokenId), or NULL when the request was authorized
// via the legacy admin password cookie.
//
// On-chain hide:caw flow (action.text='hide:caw:<cawonce>') is the
// caw owner's self-service path. Moderation is the override — same
// status flip, but anyone with role≥MODERATOR can do it on someone
// else's caw.

import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { requireModerator } from '../middleware/auth'

const router = Router()

/**
 * POST /api/moderation/caws/:id/hide
 * Hide a caw. Idempotent — re-hiding an already-HIDDEN caw is a no-op
 * but still writes an audit row (so we have evidence the moderator
 * looked at it again).
 */
router.post('/caws/:id/hide', requireModerator, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid caw id' })
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null

    const caw = await prisma.caw.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true },
    })
    if (!caw) return res.status(404).json({ error: 'Caw not found' })

    // Callback form — see admin-users.ts for why we don't use the array form.
    await prisma.$transaction(async (tx) => {
      await tx.caw.update({ where: { id }, data: { status: 'HIDDEN' } })
      await tx.moderatorAction.create({
        data: {
          actorTokenId: req.moderatorActorTokenId ?? null,
          type: 'hide_caw',
          targetCawId: id,
          targetUserId: caw.userId,
          reason,
        },
      })
    })

    return res.json({ success: true })
  } catch (err: any) {
    console.error('POST /api/moderation/caws/:id/hide error:', err)
    return res.status(500).json({ error: 'Failed to hide caw' })
  }
})

/**
 * POST /api/moderation/caws/:id/unhide
 * Reverse a previous hide. Doesn't restore the caw if it was hidden by
 * the author themselves on-chain (those flow through ActionProcessor
 * and we don't want to silently re-publish someone's deleted post).
 * We only unhide caws whose most-recent ModeratorAction is hide_caw.
 */
router.post('/caws/:id/unhide', requireModerator, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid caw id' })
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null

    const caw = await prisma.caw.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true },
    })
    if (!caw) return res.status(404).json({ error: 'Caw not found' })

    // Only proceed if the caw was hidden by a moderator (last action of
    // either type for this caw is hide_caw). Otherwise this is the
    // author's own delete — leave it alone.
    const lastAction = await prisma.moderatorAction.findFirst({
      where: { targetCawId: id, type: { in: ['hide_caw', 'unhide_caw'] } },
      orderBy: { createdAt: 'desc' },
      select: { type: true },
    })
    if (lastAction?.type !== 'hide_caw') {
      return res.status(409).json({ error: 'Caw was not hidden by a moderator; refusing to unhide' })
    }

    await prisma.$transaction(async (tx) => {
      await tx.caw.update({ where: { id }, data: { status: 'SUCCESS' } })
      await tx.moderatorAction.create({
        data: {
          actorTokenId: req.moderatorActorTokenId ?? null,
          type: 'unhide_caw',
          targetCawId: id,
          targetUserId: caw.userId,
          reason,
        },
      })
    })

    return res.json({ success: true })
  } catch (err: any) {
    console.error('POST /api/moderation/caws/:id/unhide error:', err)
    return res.status(500).json({ error: 'Failed to unhide caw' })
  }
})

/**
 * GET /api/moderation/audit
 * Paginated audit log. Admins-and-up can filter by actor or target.
 * Mostly diagnostic — there's no UI for it yet, but the table exists.
 */
router.get('/audit', requireModerator, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)
    const offset = parseInt(req.query.offset as string) || 0
    const actorTokenId = req.query.actor ? parseInt(req.query.actor as string) : undefined
    const type = typeof req.query.type === 'string' ? req.query.type : undefined

    const where: any = {}
    if (actorTokenId !== undefined && Number.isFinite(actorTokenId)) where.actorTokenId = actorTokenId
    if (type) where.type = type

    const [rows, total] = await Promise.all([
      prisma.moderatorAction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          actor: { select: { tokenId: true, username: true } },
        },
      }),
      prisma.moderatorAction.count({ where }),
    ])

    return res.json({ rows, total })
  } catch (err: any) {
    console.error('GET /api/moderation/audit error:', err)
    return res.status(500).json({ error: 'Failed to fetch audit log' })
  }
})

export default router

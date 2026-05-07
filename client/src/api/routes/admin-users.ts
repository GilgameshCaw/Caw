// /api/admin/users/* — admin-only user management.
//
// Today: role assignment (promote a tokenId to MODERATOR or ADMIN, or
// demote back to USER) and a listing of currently-elevated users.
// Future: ban/unban.
//
// Gated on requireWalletAdmin — wallet session with role=ADMIN, OR the
// legacy admin password cookie. Moderators CANNOT promote other
// moderators.

import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { requireWalletAdmin } from '../middleware/auth'

const router = Router()

const VALID_ROLES = new Set(['USER', 'MODERATOR', 'ADMIN'])

/**
 * GET /api/admin/users/elevated
 * List every User with role MODERATOR or ADMIN. Used by the FE admin
 * panel to render the moderator-management table.
 */
router.get('/elevated', requireWalletAdmin, async (_req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { role: { in: ['MODERATOR', 'ADMIN'] } },
      select: { tokenId: true, username: true, role: true, address: true },
      orderBy: [{ role: 'desc' }, { username: 'asc' }],
    })
    return res.json({ users })
  } catch (err: any) {
    console.error('GET /api/admin/users/elevated error:', err)
    return res.status(500).json({ error: 'Failed to fetch elevated users' })
  }
})

/**
 * POST /api/admin/users/:tokenId/role
 * Body: { role: 'USER' | 'MODERATOR' | 'ADMIN', reason? }
 *
 * Assign a role to a tokenId. Audit-logged as 'set_role'.
 *
 * Self-demotion guard: an admin cannot demote themselves below ADMIN —
 * removes the "I locked myself out" footgun. Bypassable only via
 * BOOTSTRAP_ADMIN_TOKEN_IDS env var (see middleware/auth.ts) or direct
 * SQL. Admin-cookie callers can demote anyone since they have no
 * tokenId attached.
 */
router.post('/:tokenId/role', requireWalletAdmin, async (req, res) => {
  try {
    const tokenId = parseInt(req.params.tokenId, 10)
    if (!Number.isFinite(tokenId) || tokenId <= 0) {
      return res.status(400).json({ error: 'Invalid tokenId' })
    }
    const { role, reason } = req.body ?? {}
    if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
      return res.status(400).json({ error: 'role must be USER, MODERATOR, or ADMIN' })
    }
    const target = await prisma.user.findUnique({
      where: { tokenId },
      select: { tokenId: true, username: true, role: true },
    })
    if (!target) return res.status(404).json({ error: 'User not found' })

    // Self-demotion guard.
    if (
      req.moderatorActorTokenId === tokenId &&
      target.role === 'ADMIN' &&
      role !== 'ADMIN'
    ) {
      return res.status(409).json({
        error: 'Refusing to demote yourself. Have another admin do it.',
      })
    }

    if (target.role === role) {
      return res.json({ success: true, noop: true, user: target })
    }

    const trimmedReason = typeof reason === 'string' ? reason.slice(0, 500) : null

    const [updated] = await prisma.$transaction([
      prisma.user.update({
        where: { tokenId },
        data: { role: role as any },
        select: { tokenId: true, username: true, role: true },
      }),
      prisma.moderatorAction.create({
        data: {
          actorTokenId: req.moderatorActorTokenId ?? null,
          type: 'set_role',
          targetUserId: tokenId,
          reason: trimmedReason
            ? `${target.role} → ${role}: ${trimmedReason}`
            : `${target.role} → ${role}`,
        },
      }),
    ])

    return res.json({ success: true, user: updated })
  } catch (err: any) {
    console.error('POST /api/admin/users/:tokenId/role error:', err)
    return res.status(500).json({ error: 'Failed to set role' })
  }
})

export default router

/**
 * Admin endpoints for sponsor invite-code management.
 *
 *   POST /api/admin/sponsor-codes  — generate + insert a new code
 *   GET  /api/admin/sponsor-codes  — list codes (no raw code returned)
 *
 * Cookie-gated via requireAdmin (same as admin-db.ts, admin-users.ts).
 */

import { Router } from 'express'
import { z, ZodError } from 'zod'
import { requireAdmin } from '../middleware/auth'
import { prisma } from '../../prismaClient'
import { createSponsorCode, SponsorCodeCollisionError } from '../../services/SponsorService/createSponsorCode'

const router = Router()

// All routes require admin auth.
router.use(requireAdmin)

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const CreateCodeSchema = z.object({
  tier:               z.enum(['short', 'long']),
  maxUses:            z.number().int().positive().optional(),
  maxDepositCawWei:   z.string().regex(/^\d+$/, 'must be a decimal integer string'),
  budgetCapUsdCents:  z.number().int().positive(),
  minUsernameLength:  z.number().int().nonnegative().optional().default(0),
  expiresInHours:     z.number().positive().optional(),
  label:              z.string().max(200).optional(),
})

// ─── POST /api/admin/sponsor-codes ──────────────────────────────────────────

router.post('/', async (req, res) => {
  // Validate env setup first.
  if (!process.env.SPONSOR_CODE_HMAC_SECRET) {
    return res.status(503).json({
      error: 'MISSING_HMAC_SECRET',
      detail: 'SPONSOR_CODE_HMAC_SECRET is not configured on this node',
    })
  }

  let body: z.infer<typeof CreateCodeSchema>
  try {
    body = CreateCodeSchema.parse(req.body)
  } catch (e) {
    const detail = e instanceof ZodError
      ? e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')
      : String(e)
    return res.status(400).json({ error: 'VALIDATION', detail })
  }

  // Tier-level budget cap guards.
  if (body.tier === 'short' && body.budgetCapUsdCents > 1000) {
    return res.status(400).json({
      error: 'VALIDATION',
      detail: 'Tier 1 (short) codes may not exceed $10 budget cap (1000 cents)',
    })
  }
  if (body.tier === 'long' && body.budgetCapUsdCents > 10000) {
    return res.status(400).json({
      error: 'VALIDATION',
      detail: 'Tier 2 (long) codes may not exceed $100 budget cap (10000 cents)',
    })
  }

  const expiresInHours = body.expiresInHours ?? (body.tier === 'short' ? 24 : 30 * 24)
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000)

  // Generate + persist via the shared helper (handles hash + collision retry).
  try {
    const { rawCode } = await createSponsorCode({
      tier: body.tier,
      budgetCapUsdCents: body.budgetCapUsdCents,
      maxDepositCawWei: body.maxDepositCawWei,
      expiresAt,
      maxUses: body.maxUses,
      minUsernameLength: body.minUsernameLength,
      label: body.label ?? null,
      createdBy: req.sessionData?.authorizedAddresses?.[0] ?? null,
    })
    // Return the raw code once — it is not stored on the SponsorCode row and
    // cannot be recovered after this response.
    return res.status(201).json({ code: rawCode })
  } catch (e) {
    if (e instanceof SponsorCodeCollisionError) {
      return res.status(500).json({ error: 'COLLISION', detail: 'Generated code collided twice — try again' })
    }
    // hashCode throws when SPONSOR_CODE_HMAC_SECRET is unset.
    return res.status(503).json({
      error: 'HASH_FAILED',
      detail: 'SPONSOR_CODE_HMAC_SECRET is not set — cannot hash code',
    })
  }
})

// ─── GET /api/admin/sponsor-codes ────────────────────────────────────────────

router.get('/', async (_req, res) => {
  const codes = await prisma.sponsorCode.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { redemptions: true } },
      redemptions: {
        select: { totalUsdCents: true },
      },
    },
  })

  const result = codes.map((c) => ({
    // Show only the last 8 chars of the hash for audit identification.
    codeHashSuffix:      c.codeHash.slice(-8),
    tier:                c.tier,
    label:               c.label,
    maxUses:             c.maxUses,
    usesRemaining:       c.usesRemaining,
    totalRedemptions:    c._count.redemptions,
    totalSpentUsdCents:  c.redemptions.reduce((sum: number, r: { totalUsdCents: number }) => sum + r.totalUsdCents, 0),
    budgetCapUsdCents:   c.budgetCapUsdCents,
    expiresAt:           c.expiresAt,
    createdBy:           c.createdBy,
    createdAt:           c.createdAt,
  }))

  return res.status(200).json(result)
})

export default router

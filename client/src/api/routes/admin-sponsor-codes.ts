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
import { generateShortCode, generateLongCode, hashCode } from '../../services/SponsorService/codes'

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

  // Generate the raw code and hash it.
  const rawCode = body.tier === 'short' ? generateShortCode() : generateLongCode()
  let codeHash: string
  try {
    codeHash = hashCode(rawCode)
  } catch (e) {
    return res.status(503).json({
      error: 'HASH_FAILED',
      detail: 'SPONSOR_CODE_HMAC_SECRET is not set — cannot hash code',
    })
  }

  // Check for hash collision (astronomically unlikely, but guard it).
  const existing = await prisma.sponsorCode.findUnique({ where: { codeHash } })
  if (existing) {
    // Regenerate once — if it collides again, fail gracefully.
    const rawCode2 = body.tier === 'short' ? generateShortCode() : generateLongCode()
    const codeHash2 = hashCode(rawCode2)
    const existing2 = await prisma.sponsorCode.findUnique({ where: { codeHash: codeHash2 } })
    if (existing2) {
      return res.status(500).json({ error: 'COLLISION', detail: 'Generated code collided twice — try again' })
    }
    await prisma.sponsorCode.create({
      data: {
        codeHash: codeHash2,
        tier: body.tier,
        label: body.label ?? null,
        budgetCapUsdCents: body.budgetCapUsdCents,
        maxDepositCawWei: body.maxDepositCawWei,
        maxUses: body.maxUses ?? (body.tier === 'long' ? 1 : null),
        usesRemaining: body.maxUses ?? (body.tier === 'long' ? 1 : null),
        minUsernameLength: body.minUsernameLength,
        expiresAt,
        createdBy: req.sessionData?.authorizedAddresses?.[0] ?? null,
      },
    })
    return res.status(201).json({ code: rawCode2 })
  }

  await prisma.sponsorCode.create({
    data: {
      codeHash,
      tier: body.tier,
      label: body.label ?? null,
      budgetCapUsdCents: body.budgetCapUsdCents,
      maxDepositCawWei: body.maxDepositCawWei,
      maxUses: body.maxUses ?? (body.tier === 'long' ? 1 : null),
      usesRemaining: body.maxUses ?? (body.tier === 'long' ? 1 : null),
      minUsernameLength: body.minUsernameLength,
      expiresAt,
      createdBy: req.sessionData?.authorizedAddresses?.[0] ?? null,
    },
  })

  // Return the raw code once — it is not stored in the DB and cannot be
  // recovered after this response.
  return res.status(201).json({ code: rawCode })
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

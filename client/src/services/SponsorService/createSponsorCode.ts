// services/SponsorService/createSponsorCode.ts
//
// Shared sponsor-code minting: generate a raw code, hash it, guard against a
// (astronomically unlikely) hash collision with a single retry, and insert the
// SponsorCode row. Returns the plaintext code ONCE — it is never stored on the
// SponsorCode row (only the HMAC hash is).
//
// Used by:
//   - POST /api/admin/sponsor-codes (admin-minted codes)
//   - the paid sponsor-invite OTHER-action handler (buyer-minted codes)
// so the generate/hash/collision-retry logic lives in exactly one place.

import { prisma } from '../../prismaClient'
import { generateShortCode, generateLongCode, hashCode } from './codes'

export interface CreateSponsorCodeOpts {
  tier: 'short' | 'long'
  budgetCapUsdCents: number
  maxDepositCawWei: string
  expiresAt: Date
  maxUses?: number | null
  minUsernameLength?: number
  label?: string | null
  createdBy?: string | null
  repayBps?: number
  requireKycLevel?: number
  /** Buyer's profile tokenId when this code was paid-for (null for admin codes). */
  purchasedByTokenId?: number | null
}

export interface CreatedSponsorCode {
  rawCode: string
  codeHash: string
}

class SponsorCodeCollisionError extends Error {
  constructor() {
    super('Generated sponsor code collided twice')
    this.name = 'SponsorCodeCollisionError'
  }
}

/**
 * Generate + persist a SponsorCode. Throws if SPONSOR_CODE_HMAC_SECRET is unset
 * (hashCode throws) or on a double hash collision (SponsorCodeCollisionError).
 * The defaulting of maxUses/usesRemaining matches the prior admin-route logic:
 * long tier defaults to single-use, short tier to unlimited (null).
 */
export async function createSponsorCode(opts: CreateSponsorCodeOpts): Promise<CreatedSponsorCode> {
  const gen = () => (opts.tier === 'short' ? generateShortCode() : generateLongCode())
  const defaultUses = opts.maxUses ?? (opts.tier === 'long' ? 1 : null)

  // Try once, then retry once on collision; fail loudly if it collides twice.
  let rawCode = gen()
  let codeHash = hashCode(rawCode)
  if (await prisma.sponsorCode.findUnique({ where: { codeHash } })) {
    rawCode = gen()
    codeHash = hashCode(rawCode)
    if (await prisma.sponsorCode.findUnique({ where: { codeHash } })) {
      throw new SponsorCodeCollisionError()
    }
  }

  await prisma.sponsorCode.create({
    data: {
      codeHash,
      tier: opts.tier,
      label: opts.label ?? null,
      budgetCapUsdCents: opts.budgetCapUsdCents,
      maxDepositCawWei: opts.maxDepositCawWei,
      maxUses: defaultUses,
      usesRemaining: defaultUses,
      minUsernameLength: opts.minUsernameLength ?? 0,
      expiresAt: opts.expiresAt,
      createdBy: opts.createdBy ?? null,
      repayBps: opts.repayBps ?? 0,
      requireKycLevel: opts.requireKycLevel ?? 0,
      purchasedByTokenId: opts.purchasedByTokenId ?? null,
    },
  })

  return { rawCode, codeHash }
}

export { SponsorCodeCollisionError }

// services/SponsorService/validatorIdentity.ts
//
// Resolves THIS server's own sponsor/validator profile tokenId — the profile
// that must be named as recipients[0] on a paid sponsor-invite OTHER action so
// that exactly THIS mirror (the one holding the buyer's tip) mints the code.
//
// We reuse the existing PLATFORM_SPONSOR_TOKEN_ID env (the operator's own
// profile, already used by the sponsor flow as the repay/sponsor profile). The
// validator/sponsor server is the entity that funds the eventual gift, so its
// own profile is the correct tip target. Default 1 = the first operator profile.

/**
 * This server's own validator/sponsor profile tokenId, or null when not
 * configured to a valid positive integer. Async + catchable so callers can
 * treat "unknown identity" as "don't act" rather than throwing.
 */
export async function getOwnValidatorTokenId(): Promise<number | null> {
  const raw = process.env.PLATFORM_SPONSOR_TOKEN_ID
  const n = raw === undefined ? 1 : Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Synchronous variant for hot paths (the ActionProcessor gate). Same logic. */
export function getOwnValidatorTokenIdSync(): number | null {
  const raw = process.env.PLATFORM_SPONSOR_TOKEN_ID
  const n = raw === undefined ? 1 : Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

// services/SponsorService/validatorIdentity.ts
//
// Resolves THIS server's own sponsor/validator profile tokenId — the profile
// that must be named as recipients[0] on a paid sponsor-invite OTHER action so
// that exactly THIS mirror (the one holding the buyer's tip) mints the code.
//
// We reuse the existing PLATFORM_SPONSOR_TOKEN_ID env (the operator's own
// profile, already used by the sponsor flow as the repay/sponsor profile). The
// validator/sponsor server is the entity that funds the eventual gift, so its
// own profile is the correct tip target.
//
// IMPORTANT (L-5): this gate must NOT silently default to a tokenId when the env
// is unset. A default would make an UNCONFIGURED mirror match buy-a-code actions
// tipping that default id and mint codes it can't fund. So an unset/invalid env
// resolves to null -> the buy-a-code handler no-ops. (This differs from the
// sponsor-flow's own default-1 fallback elsewhere, which is for a different,
// operator-controlled path.)

function resolve(): number | null {
  const raw = process.env.PLATFORM_SPONSOR_TOKEN_ID
  if (raw === undefined || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * This server's own validator/sponsor profile tokenId, or null when not
 * explicitly configured. Async + catchable for callers that prefer it.
 */
export async function getOwnValidatorTokenId(): Promise<number | null> {
  return resolve()
}

/** Synchronous variant for hot paths (the ActionProcessor gate). Same logic. */
export function getOwnValidatorTokenIdSync(): number | null {
  return resolve()
}

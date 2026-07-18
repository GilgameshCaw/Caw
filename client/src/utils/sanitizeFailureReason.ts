/**
 * sanitizeFailureReason — turn a raw failure reason (often a verbatim ethers /
 * RPC / wallet error) into a short, user-friendly sentence before it is stored on
 * a TxQueue row and surfaced in an ACTION_FAILED notification.
 *
 * Why this exists: raw ethers v6 messages like
 *   `provider destroyed; cancelled request (operation="eth_getBlockByNumber",
 *    code=UNSUPPORTED_OPERATION, version=6.16.0)`
 * were reaching users verbatim in "Tip to @x failed" notifications. This is the
 * SERVER-SIDE choke point (called from markTxQueueFailed), so the raw string never
 * even lands in the DB. The FE has a matching render-side humanizer
 * (describeFailedReason in Notifications.tsx) as defense in depth for any reasons
 * stored before this shipped.
 *
 * Design: map KNOWN classes to friendly copy; for anything unrecognized that LOOKS
 * like a raw technical/ethers error, fall back to a generic message rather than
 * leaking the raw string. Genuinely user-meaningful reasons (e.g. our own
 * "Insufficient balance") pass through untouched.
 */

/** Heuristics that mark a string as raw technical noise unfit for a user. */
function looksLikeRawTechnicalError(msg: string): boolean {
  const m = msg.toLowerCase()
  return (
    // ethers v6 signatures
    m.includes('code=') ||
    m.includes('version=') ||
    m.includes('operation="') ||
    m.includes('action="') ||
    m.includes('provider destroyed') ||
    m.includes('cancelled request') ||
    m.includes('unsupported_operation') ||
    m.includes('call_exception') ||
    m.includes('could not coalesce') ||
    m.includes('missing revert data') ||
    // node / RPC transport noise
    m.includes('econnrefused') ||
    m.includes('econnreset') ||
    m.includes('enotfound') ||
    m.includes('etimedout') ||
    m.includes('socket hang up') ||
    m.includes('0x') && m.length > 80 // long hex-bearing strings are almost always raw calldata/errors
  )
}

/**
 * Map a raw failure reason to a friendly one. Returns a short user-facing sentence.
 * `fallback` is used when the reason is unrecognized raw noise (default generic).
 */
export function sanitizeFailureReason(reason: string | null | undefined, fallback = 'Something went wrong. Please try again.'): string {
  const raw = (reason ?? '').trim()
  if (!raw) return fallback
  const m = raw.toLowerCase()

  // ── Transient network / provider errors → "try again" ──────────────────────
  if (
    m.includes('provider destroyed') ||
    m.includes('cancelled request') ||
    m.includes('unsupported_operation') ||
    m.includes('too many requests') ||
    m.includes('429') ||
    m.includes('rate limit') ||
    m.includes('timeout') || m.includes('etimedout') ||
    m.includes('missing response') ||
    m.includes('econnrefused') || m.includes('econnreset') || m.includes('enotfound') ||
    m.includes('socket hang up') ||
    m.includes('could not coalesce')
  ) {
    return 'A temporary network issue interrupted this. Please try again.'
  }

  // ── Funds / balance ────────────────────────────────────────────────────────
  if (m.includes('insufficient') && (m.includes('balance') || m.includes('funds') || m.includes('stake') || m.includes('caw'))) {
    return 'Insufficient balance to complete this action.'
  }

  // ── Already applied on-chain (not really a failure) ────────────────────────
  if (m.includes('cawonce already used')) {
    return 'This action was already processed.'
  }

  // ── Session ────────────────────────────────────────────────────────────────
  if (m.includes('session expired') || m.includes('session invalid') || m.includes('session not found')) {
    return 'Your signing session expired. Please sign in again.'
  }

  // ── Generic on-chain revert ────────────────────────────────────────────────
  if (m.includes('execution reverted') || m.includes('call_exception') || m.includes('transaction reverted')) {
    return 'The transaction was rejected by the network. Please try again.'
  }

  // ── Unrecognized RAW technical noise → generic (never leak it) ─────────────
  if (looksLikeRawTechnicalError(raw)) return fallback

  // ── Otherwise it's likely one of our own human-written reasons — keep it,
  //    but cap length so an unexpectedly long one can't blow up the UI.
  return raw.length > 140 ? fallback : raw
}

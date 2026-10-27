/**
 * Whether a failed TxQueue row's `reason` is the validator's "Cawonce already
 * used" rejection — the case useTxQueueMonitor may retry with a fresh cawonce.
 *
 * The server doesn't store that phrase: markTxQueueFailed runs every reason
 * through sanitizeFailureReason (client/src/utils/sanitizeFailureReason.ts),
 * which stores it as CAWONCE_USED_REASON. Keep the string below in step with
 * that constant. Rows written before the sanitizer still carry the raw phrase.
 *
 * The stored sentence is compared whole: the validator's other duplicate
 * wording, "Transaction already processed - duplicate cawonce", is stored
 * as-is and was never auto-retried.
 */
const STORED_CAWONCE_USED_REASON = 'this action was already processed.'

export function isCawonceUsedReason(reason: string | null | undefined): boolean {
  const r = (reason ?? '').trim().toLowerCase()
  return r === STORED_CAWONCE_USED_REASON || r.includes('cawonce already used')
}

/** GET /api/txqueue/check-landed/:id. A failed check counts as 'unknown'. */
export type LandedVerdict = 'ours' | 'collision' | 'unknown'

/**
 * Only 'collision' (the slot holds a different action) is worth a retry.
 * 'unknown' means the Action row isn't indexed yet, and the usual reason is
 * that another validator landed this same action moments before ours was
 * rejected. Retrying then posts it a second time at a fresh cawonce.
 */
export function shouldRetryCawonceUsed(verdict: LandedVerdict): boolean {
  return verdict === 'collision'
}

/**
 * Asks `check` about each entry in order and returns up to `max` entries to
 * retry. Entries whose action is already on chain come back as `landed`; the
 * rest ('unknown') are left for a later page load.
 */
export async function pickCawonceUsedRetries<T extends { id: number }>(
  entries: T[],
  check: (txQueueId: number) => Promise<LandedVerdict>,
  max: number,
): Promise<{ retry: T[]; landed: T[] }> {
  const retry: T[] = []
  const landed: T[] = []
  for (const entry of entries) {
    if (retry.length >= max) break
    const verdict = await check(entry.id)
    if (verdict === 'ours') landed.push(entry)
    else if (shouldRetryCawonceUsed(verdict)) retry.push(entry)
  }
  return { retry, landed }
}

// What a failed eth_getLogs says about the block range it was asked for, and
// the window to retry with. RPCs cap the range of one call and the caps differ
// (and move): a window that fits one provider is rejected by another.

// How RPCs name the range they allow (wording seen on 2026-10-27, Base Sepolia):
//   sepolia.base.org   "eth_getLogs is limited to a 200 range"
//   publicnode         "exceed maximum block range: 50000"
//   nodies             "Block range too large: maximum allowed is 50 blocks on your current plan"
//   drpc               "ranges over 10000 blocks are not supported on free plan"
// "-block" and a thousands separator ("10,000") are accepted too.
const RANGE_CAP_RES = [
  /limited to (?:a )?(\d[\d,]*)[ -]?(?:block )?range/i,
  /maximum (?:block )?range:? (?:is )?(\d[\d,]*)/i,
  /maximum allowed is (\d[\d,]*) blocks?/i,
  /ranges? over (\d[\d,]*) blocks?/i,
]

// Errors that say the range was too wide, or the answer too large, without a
// usable number. HTTP 413 is matched by its reason phrase, not by "413", which
// also turns up as a JSON-RPC request id in ethers' error message.
const RANGE_ERROR_RE =
  /payload too large|limited to [^|]{0,40}range|block range|ranges? (?:is |are )?(?:too (?:large|wide|big)|over \d)|exceed\w* (?:the )?(?:max\w* )?(?:block )?range|more than \d[\d,]* (?:results|logs)|too many (?:results|logs)|response size (?:exceeded|too large)/i

// The text an RPC put in a getLogs failure. ethers v6 puts the JSON-RPC error
// in `error` ("could not coalesce error") and the HTTP status and body in
// `info`; wrappers nest the original under `error` / `cause`.
export function errorText(err: any, depth = 0): string {
  if (err == null || depth > 3) return ''
  if (typeof err !== 'object') return String(err)
  const parts: string[] = []
  for (const v of [err.message, err.shortMessage, err.info?.responseStatus, err.info?.responseBody, err.body]) {
    if (typeof v === 'string') parts.push(v)
  }
  for (const inner of [err.error, err.cause, err.info?.error]) {
    if (inner && inner !== err) parts.push(errorText(inner, depth + 1))
  }
  return parts.join(' | ')
}

/**
 * The window to retry with after a window of `span` blocks failed with `err`,
 * or undefined when the failure is not about the size of the range (rate
 * limit, outage, anything unrecognised) or the window is already one block.
 *
 *  - The RPC named its cap: that many blocks.
 *  - The RPC said the range was too wide, without a number: half the window.
 *
 * The caller retries the SAME range with the smaller window; it never skips
 * one, so a result is never built from a partial scan.
 */
export function shrinkWindow(err: unknown, span: number): number | undefined {
  if (!(span > 1)) return undefined
  const text = errorText(err)
  for (const re of RANGE_CAP_RES) {
    const cap = re.exec(text)
    if (!cap) continue
    const n = Number(cap[1].replace(/,/g, ''))
    if (Number.isInteger(n) && n >= 1 && n < span) return n
  }
  if (RANGE_ERROR_RE.test(text)) return Math.max(1, Math.floor(span / 2))
  return undefined
}

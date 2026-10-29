/**
 * Extract a user-friendly message from an error thrown by wagmi/viem/wallet
 * libraries. Viem errors come with "Details:" and "Version: viem@x.y.z"
 * trailers that users don't need to see — strip them.
 *
 * Examples:
 *   "User rejected the request. Details: User rejected the request. Version: viem@2.31.3"
 *     → "User rejected the request"
 */
export function formatWalletError(err: unknown): string {
  if (!err) return 'Something went wrong'
  const raw = err instanceof Error ? err.message : String(err)
  const lower = raw.toLowerCase()

  // Normalize common user-rejection variants to a single clean string.
  if (/user\s*(rejected|denied|cancelled)/i.test(raw)) {
    return 'User rejected the request'
  }

  // A contract revert from viem: 'The contract function "x" reverted with the
  // following reason:\n<reason>'. The reason is on the second line, which the
  // first-line cleanup at the bottom would drop, and it is the useful part
  // ("Offer not active"). Checked before the network-issue test below so that
  // a revert is never taken for a network problem because of what its message
  // happens to contain (an address, a number in the reason).
  const reverted = raw.match(/reverted with the following reason:\s*\n\s*([^\n]+)/i)
  if (reverted) {
    const reason = reverted[1].trim()
    if (reason && reason.length <= 160 && !/code=|version=|operation="|action="/i.test(reason)) return reason
  }
  // A revert with a custom error the ABI can't decode: the first line ends in a
  // colon and the rest is a raw selector, so there is nothing friendly to show.
  if (/reverted with the following (reason|signature):/i.test(raw)) {
    return 'The transaction was rejected by the network. Please try again.'
  }

  // Transient network / provider teardown (ethers v6 "provider destroyed; cancelled
  // request … UNSUPPORTED_OPERATION", RPC rate-limits, transport hiccups). These are
  // retryable, not a bad action — never show the raw ethers string to the user.
  // 429 is matched as a whole number: as a substring it also matched addresses
  // and hashes in the message (0x...429...).
  if (
    lower.includes('provider destroyed') || lower.includes('cancelled request') ||
    lower.includes('unsupported_operation') || lower.includes('too many requests') ||
    /\b429\b/.test(lower) || lower.includes('rate limit') || lower.includes('timeout') ||
    lower.includes('missing response') || lower.includes('could not coalesce') ||
    lower.includes('econnreset') || lower.includes('econnrefused') || lower.includes('enotfound')
  ) {
    return 'A temporary network issue interrupted this. Please try again.'
  }

  // On-chain revert / call exception — verbose ethers noise, unhelpful raw.
  if (lower.includes('call_exception') || lower.includes('execution reverted') || lower.includes('transaction reverted')) {
    return 'The transaction was rejected by the network. Please try again.'
  }

  // Strip viem's "Details:" and "Version:" trailers from the first line.
  const cleaned = raw
    .split('\n')[0]
    .replace(/\s*Details:\s*.*$/i, '')
    .replace(/\s*Version:\s*viem@[\w.-]+\s*$/i, '')
    .trim()

  // If what remains still looks like raw ethers noise (code=/version=/operation=)
  // or is too long to be a friendly sentence, fall back to a generic message rather
  // than leaking it.
  if (/code=|version=|operation="|action="/i.test(cleaned) || cleaned.length > 160) {
    return 'Something went wrong. Please try again.'
  }
  return cleaned || 'Something went wrong'
}

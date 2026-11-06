import { parseUnits } from 'viem'

/**
 * Parse what's in an 18-decimal amount field, for use during render. An
 * `<input type="number">` lets through values parseUnits throws on, like `1e5`, and
 * a throw during render replaces the whole app with the error page. Anything that
 * doesn't parse counts as 0, which leaves the submit buttons disabled.
 */
export function parseAmountWei(amount: string | null | undefined): bigint {
  try {
    return parseUnits(amount || '0', 18)
  } catch {
    return 0n
  }
}

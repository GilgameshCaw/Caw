// src/utils/numberFormat.ts

/**
 * Format large numbers with K, M, B suffixes
 * @param num - The number to format
 * @returns Formatted string (e.g., 1200 -> "1.2K", 1500000 -> "1.5M")
 */
export function formatLargeNumber(num: number): string {
  if (num < 1000) {
    return num.toString()
  }

  const tiers = [
    { suffix: 'K', size: 1e3 },
    { suffix: 'M', size: 1e6 },
    { suffix: 'B', size: 1e9 },
  ]
  let tier = num >= 1e9 ? 2 : num >= 1e6 ? 1 : 0
  let formatted = (num / tiers[tier].size).toFixed(1)
  // Rounding can reach 1000 in the tier below (999,999 -> "1000.0"): show it in
  // the next tier ("1M") instead of "1000K".
  if (parseFloat(formatted) >= 1000 && tier < tiers.length - 1) {
    tier++
    formatted = (num / tiers[tier].size).toFixed(1)
  }
  // Remove trailing .0
  return (formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted) + tiers[tier].suffix
}

/**
 * Format usage counts for hashtags with proper suffixes
 * @param count - The usage count
 * @returns Formatted string with "caws" suffix
 */
export function formatUsageCount(count: number): string {
  const formattedNumber = formatLargeNumber(count)
  return count === 1 ? '1 caw' : `${formattedNumber} caws`
}

/**
 * Format engagement counts (likes, recaws, comments) with proper suffixes
 * @param count - The engagement count
 * @returns Formatted string
 */
export function formatEngagementCount(count: number): string {
  return formatLargeNumber(count)
}

/**
 * Format CAW token amounts (converts from wei to human readable)
 * @param amount - The amount in wei as string or bigint
 * @returns Formatted string with CAW suffix (e.g., "1.5M CAW")
 */
export function formatCAWAmount(amount: string | bigint): string {
  if (!amount || amount === '0') return '0 CAW'

  // Convert to bigint if string
  const amountBigInt = typeof amount === 'string' ? BigInt(amount) : amount

  // Convert from wei (18 decimals) to whole CAW
  const cawAmount = Number(amountBigInt) / 1e18

  if (cawAmount < 1) {
    return cawAmount.toFixed(2) + ' CAW'
  }

  return formatLargeNumber(Math.floor(cawAmount)) + ' CAW'
}

/**
 * Format a US dollar amount with reader-friendly precision.
 *
 * Rules:
 *   - amount >= $0.02  →  2 decimals ("$0.05", "$1.23", "$1,234.56")
 *   - amount <  $0.02  →  keep adding decimals until the last two non-zero
 *                         digits are visible ("$0.011", "$0.00076", "$0.0000038")
 *   - amount == 0       →  "$0.00"
 *   - negatives        →  prefixed with "-" (the absolute value is formatted)
 *
 * CAW is denominated tiny in USD (~$3.8e-8 / CAW), so per-action costs land
 * deep in the sub-cent range. Without this helper, toFixed(2) renders every
 * sub-cent value as "$0.00", which is misleading.
 *
 * Does NOT prepend "~" or whitespace — callers add their own context. Examples:
 *   `$${formatUsd(0.0011)}`  →  "$0.0011"
 *   `~$${formatUsd(0.000076)}` →  "~$0.000076"
 */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return '0.00'
  const negative = amount < 0
  const abs = Math.abs(amount)
  if (abs === 0) return '0.00'

  // ≥ $0.02 — standard 2-decimal currency rendering with locale-aware
  // thousands separators (matches the rest of the UI's $X,XXX.XX style).
  if (abs >= 0.02) {
    const formatted = abs.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
    return (negative ? '-' : '') + formatted
  }

  // < $0.02 — find the position of the FIRST non-zero digit after the
  // decimal point, then keep one more digit so the user sees two non-zero
  // digits at the end. Math.log10 isn't reliable on very small numbers due
  // to float precision, so we hand-walk the decimal string.
  //
  // Example: 0.00076 → first non-zero at index 3 (three zeros before the 7)
  //          → render with 5 fraction digits → "0.00076"
  // Example: 0.0001234 → three zeros before the 1 → render 5 digits
  //          → "0.00012" (two non-zero digits: '1','2')
  //
  // The exponent comes from toExponential(), not from toString(): toString()
  // switches to exponent notation below 1e-6 ("3.8e-8") and then has no
  // decimal digits to walk, which used to render every such amount as "0.00".
  const exponent = Number(abs.toExponential().split('e')[1]) // 0.00076 → -4
  const firstNonZero = -exponent - 1 // zeros after the decimal point, before the first non-zero digit
  // Need firstNonZero zeros + 2 nonzero = firstNonZero + 2 fraction digits.
  // toFixed handles rounding correctly.
  const fractionDigits = Math.min(firstNonZero + 2, 20)
  const formatted = abs.toFixed(fractionDigits)
  // Too small to show any digit within 20 places: plain zero, never "-0.00".
  if (!/[1-9]/.test(formatted)) return '0.00'
  return (negative ? '-' : '') + formatted
}
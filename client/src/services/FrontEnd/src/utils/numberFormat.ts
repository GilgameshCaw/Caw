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

  if (num < 1000000) {
    const formatted = (num / 1000).toFixed(1)
    // Remove trailing .0
    return formatted.endsWith('.0') ? formatted.slice(0, -2) + 'K' : formatted + 'K'
  }

  if (num < 1000000000) {
    const formatted = (num / 1000000).toFixed(1)
    // Remove trailing .0
    return formatted.endsWith('.0') ? formatted.slice(0, -2) + 'M' : formatted + 'M'
  }

  // For billions and above
  const formatted = (num / 1000000000).toFixed(1)
  return formatted.endsWith('.0') ? formatted.slice(0, -2) + 'B' : formatted + 'B'
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
  // Example: 0.00076 → toString → "0.00076" → first non-zero at index 4
  //          → render with 5 fraction digits → "0.00076"
  // Example: 0.0001234 → first non-zero at index 4 → render 5 digits
  //          → "0.00012" (two non-zero digits: '1','2')
  const str = abs.toString()
  // Strip "0." prefix and walk to first non-zero.
  const decimals = str.split('.')[1] ?? ''
  let firstNonZero = 0
  while (firstNonZero < decimals.length && decimals[firstNonZero] === '0') {
    firstNonZero++
  }
  // Need (firstNonZero + 1) zero-or-leading + 2 nonzero = firstNonZero + 2 fraction digits.
  // toFixed handles rounding correctly.
  const fractionDigits = Math.min(firstNonZero + 2, 20)
  const formatted = abs.toFixed(fractionDigits)
  return (negative ? '-' : '') + formatted
}
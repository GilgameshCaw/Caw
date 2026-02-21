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
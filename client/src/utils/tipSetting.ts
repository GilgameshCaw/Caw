/**
 * Parse a stored tip setting. Returns null unless it's a whole number written in
 * decimal digits. BigInt alone isn't enough: BigInt('') is 0n, and it throws on
 * '1.5'.
 */
export function parseTipSetting(value: string): bigint | null {
  return /^\d+$/.test(value) ? BigInt(value) : null
}

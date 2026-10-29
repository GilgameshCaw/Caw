import { describe, it, expect } from 'vitest'
import { formatLargeNumber, formatCAWAmount, formatUsd } from './numberFormat'

describe('formatLargeNumber', () => {
  it('keeps small numbers as they are', () => {
    expect(formatLargeNumber(0)).toBe('0')
    expect(formatLargeNumber(999)).toBe('999')
  })

  it('uses K, M and B with one decimal and drops a trailing .0', () => {
    expect(formatLargeNumber(1000)).toBe('1K')
    expect(formatLargeNumber(1499)).toBe('1.5K')
    expect(formatLargeNumber(12_345)).toBe('12.3K')
    expect(formatLargeNumber(1_000_000)).toBe('1M')
    expect(formatLargeNumber(1_234_567)).toBe('1.2M')
    expect(formatLargeNumber(1_000_000_000)).toBe('1B')
    expect(formatLargeNumber(1_500_000_000)).toBe('1.5B')
  })

  it('stays in the tier while the rounded value is below 1000', () => {
    expect(formatLargeNumber(999_949)).toBe('999.9K')
    expect(formatLargeNumber(999_949_999)).toBe('999.9M')
  })

  it('moves to the next tier when rounding reaches 1000 (not "1000K" / "1000M")', () => {
    expect(formatLargeNumber(999_950)).toBe('1M')
    expect(formatLargeNumber(999_999)).toBe('1M')
    expect(formatLargeNumber(999_950_000)).toBe('1B')
    expect(formatLargeNumber(999_999_999)).toBe('1B')
  })
})

describe('formatCAWAmount', () => {
  const wei = (caw: string) => (BigInt(caw) * 10n ** 18n).toString()

  it('shows zero, a fraction and whole amounts', () => {
    expect(formatCAWAmount('0')).toBe('0 CAW')
    expect(formatCAWAmount('500000000000000000')).toBe('0.50 CAW')
    expect(formatCAWAmount(wei('1500000'))).toBe('1.5M CAW')
  })

  it('does not show 1000K for an amount just under a million', () => {
    expect(formatCAWAmount('999999900000000000000000')).toBe('1M CAW') // 999,999.9 CAW
    expect(formatCAWAmount(wei('999999'))).toBe('1M CAW')
  })
})

describe('formatUsd', () => {
  it('uses two decimals from $0.02 up, with thousands separators', () => {
    expect(formatUsd(0.02)).toBe('0.02')
    expect(formatUsd(1.234)).toBe('1.23')
    expect(formatUsd(1234.5)).toBe('1,234.50')
  })

  it('shows zero, and 0.00 for a value that is not finite', () => {
    expect(formatUsd(0)).toBe('0.00')
    expect(formatUsd(NaN)).toBe('0.00')
    expect(formatUsd(Infinity)).toBe('0.00')
  })

  it('shows two significant digits below $0.02', () => {
    expect(formatUsd(0.0123)).toBe('0.012')
    expect(formatUsd(0.019999)).toBe('0.020')
    expect(formatUsd(0.00076)).toBe('0.00076')
    expect(formatUsd(0.0001234)).toBe('0.00012')
    expect(formatUsd(0.0000038)).toBe('0.0000038')
  })

  it('still shows digits below $0.000001, where toString() switches to exponent notation', () => {
    expect(formatUsd(9.9e-7)).toBe('0.00000099')
    expect(formatUsd(1e-7)).toBe('0.00000010')
    expect(formatUsd(3.8e-8)).toBe('0.000000038') // about the price of one CAW
    expect(formatUsd(10 * 3.8e-8)).toBe('0.00000038') // ten CAW
  })

  it('prefixes a minus sign for negative amounts, small ones included', () => {
    expect(formatUsd(-5.5)).toBe('-5.50')
    expect(formatUsd(-0.00076)).toBe('-0.00076')
    expect(formatUsd(-3.8e-8)).toBe('-0.000000038')
  })

  it('returns plain 0.00, never -0.00, for an amount too small to show within 20 places', () => {
    expect(formatUsd(1e-25)).toBe('0.00')
    expect(formatUsd(-1e-25)).toBe('0.00')
  })
})

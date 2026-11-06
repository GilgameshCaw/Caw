import { describe, it, expect } from 'vitest'
import { parseAmountWei } from './parseAmountWei'

const E18 = 10n ** 18n

describe('parseAmountWei', () => {
  it('parses amounts', () => {
    expect(parseAmountWei('5')).toBe(5n * E18)
    expect(parseAmountWei('1.5')).toBe((3n * E18) / 2n)
    expect(parseAmountWei('0.000000000000000001')).toBe(1n)
  })

  it('reads an empty field as 0', () => {
    expect(parseAmountWei('')).toBe(0n)
    expect(parseAmountWei(undefined)).toBe(0n)
    expect(parseAmountWei(null)).toBe(0n)
  })

  it.each(['1e5', '1.2.3', 'abc', '1e-7', '.'])('reads %s as 0 rather than throwing', value => {
    expect(parseAmountWei(value)).toBe(0n)
  })
})

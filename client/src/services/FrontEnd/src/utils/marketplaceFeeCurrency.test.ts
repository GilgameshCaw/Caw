import { describe, it, expect } from 'vitest'
import { pickFeeCurrency, type FeeBudget } from './marketplaceFeeCurrency'

const base: FeeBudget = { cawBalance: 0n, cawReserved: 0n, cawFee: 3n, ethBalance: 0n, ethReserved: 0n, ethFee: 5n }
const budget = (o: Partial<FeeBudget>): FeeBudget => ({ ...base, ...o })

describe('pickFeeCurrency', () => {
  describe('the listing is paid in CAW: the price comes out of the same balance as the fee', () => {
    it('pays the fee in CAW when price + fee fit', () => {
      expect(pickFeeCurrency(budget({ cawBalance: 103n, cawReserved: 100n }))).toBe('CAW')
    })

    it('pays the fee in CAW when price + fee exactly fit', () => {
      expect(pickFeeCurrency(budget({ cawBalance: 103n, cawReserved: 100n, cawFee: 3n }))).toBe('CAW')
    })

    it('does not pick CAW when the balance covers the price and the fee separately but not together', () => {
      // 101 CAW: price 100 fits, fee 3 fits, 100 + 3 does not
      expect(pickFeeCurrency(budget({ cawBalance: 101n, cawReserved: 100n }))).toBe(null)
    })

    it('falls back to ETH when the CAW left after the price cannot pay the fee', () => {
      expect(pickFeeCurrency(budget({ cawBalance: 101n, cawReserved: 100n, ethBalance: 5n }))).toBe('ETH')
    })

    it('stops before signing when neither currency can pay the fee', () => {
      expect(pickFeeCurrency(budget({ cawBalance: 101n, cawReserved: 100n, ethBalance: 4n }))).toBe(null)
    })

    it('does not break when the price is larger than the balance', () => {
      expect(pickFeeCurrency(budget({ cawBalance: 50n, cawReserved: 100n }))).toBe(null)
      expect(pickFeeCurrency(budget({ cawBalance: 50n, cawReserved: 100n, ethBalance: 5n }))).toBe('ETH')
    })
  })

  describe('the listing is not paid in CAW: nothing is reserved in CAW', () => {
    it('pays in CAW when the balance covers the fee', () => {
      expect(pickFeeCurrency(budget({ cawBalance: 3n }))).toBe('CAW')
    })

    it('uses ETH when CAW cannot pay the fee', () => {
      expect(pickFeeCurrency(budget({ cawBalance: 2n, ethBalance: 5n }))).toBe('ETH')
    })

    it('uses ETH when there is no CAW fee quote', () => {
      expect(pickFeeCurrency(budget({ cawBalance: 1000n, cawFee: null, ethBalance: 5n }))).toBe('ETH')
    })

    it('stops when there is no CAW quote and no ETH for the fee', () => {
      expect(pickFeeCurrency(budget({ cawBalance: 1000n, cawFee: null, ethBalance: 4n }))).toBe(null)
    })
  })

  describe('the ETH side keeps counting what the batch spends in ETH', () => {
    it('needs the ETH price (and a sync fee) on top of the fee', () => {
      expect(pickFeeCurrency(budget({ ethBalance: 105n, ethReserved: 100n }))).toBe('ETH')
      expect(pickFeeCurrency(budget({ ethBalance: 104n, ethReserved: 100n }))).toBe(null)
    })
  })

  describe('when no CAW is reserved it behaves as the rule it replaces', () => {
    const old = (b: FeeBudget) =>
      (b.cawFee !== null && b.cawBalance >= b.cawFee) ? 'CAW' : (b.ethBalance >= b.ethReserved + b.ethFee ? 'ETH' : null)

    it('gives the same answer on a grid of balances and fees', () => {
      const values = [0n, 1n, 2n, 3n, 4n, 5n, 8n, 100n]
      let n = 0
      for (const cawBalance of values) for (const cawFee of [null, 0n, 3n, 100n])
        for (const ethBalance of values) for (const ethReserved of [0n, 2n, 50n]) for (const ethFee of [0n, 5n]) {
          const b: FeeBudget = { cawBalance, cawReserved: 0n, cawFee, ethBalance, ethReserved, ethFee }
          expect(pickFeeCurrency(b)).toBe(old(b)); n++
        }
      expect(n).toBeGreaterThan(1000)
    })
  })
})

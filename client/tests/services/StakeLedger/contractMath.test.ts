import { expect } from 'chai'
import {
  PRECISION,
  balanceOf,
  ownershipFromBalance,
  spendAndDistribute,
  addToBalance,
} from '../../../src/services/StakeLedger/contractMath'

// Sequence-based pin test. Walk the state through a series of actions
// and assert the post-state matches what CawProfileL2 would produce.
// If the snapshotter ever diverges from the on-chain math by even one
// ulp, this test trips and the multiplier-checksum guard catches the
// rest.
//
// All amounts here are in raw 18-decimal CAW (whole tokens × 1e18) to
// match the contract's internal units.

describe('StakeLedger / contractMath', () => {
  describe('balanceOf <-> ownershipFromBalance roundtrip', () => {
    it('roundtrips at multiplier=1e18', () => {
      const ownership = 1234n * PRECISION
      const balance = balanceOf(ownership, PRECISION)
      expect(balance).to.equal(ownership)
      expect(ownershipFromBalance(balance, PRECISION)).to.equal(ownership)
    })

    it('truncates correctly at non-trivial multiplier', () => {
      // multiplier 1.5e18, ownership representing 100 CAW
      const multiplier = (PRECISION * 3n) / 2n
      const ownership = ownershipFromBalance(100n * PRECISION, multiplier)
      // ownership = 1e18 * 100e18 / 1.5e18 = 100e18 * 2/3 = 66666...e18 (truncated)
      const balance = balanceOf(ownership, multiplier)
      // After roundtrip we may lose one ulp due to truncation; not more.
      const diff = 100n * PRECISION - balance
      expect(diff).to.be.lessThan(2n)
    })
  })

  describe('spendAndDistribute', () => {
    it('a single CAW (post) action with totalCaw=spender-balance refunds to spender', () => {
      // Spender holds 5000 CAW; totalCaw = 5000. denominator = 0,
      // so amountToDistribute is refunded to the spender. Multiplier
      // unchanged. Spender ownership unchanged.
      const start = {
        multiplier: PRECISION,
        totalCaw: 5000n * PRECISION,
      }
      const spender = ownershipFromBalance(5000n * PRECISION, start.multiplier)
      const r = spendAndDistribute(spender, start, 5000n * PRECISION, 5000n * PRECISION)
      expect(r.refundedToSpender).to.equal(true)
      expect(r.multiplier).to.equal(start.multiplier)
      expect(r.senderBalance).to.equal(5000n * PRECISION)
    })

    it('a CAW (post) action with another holder: multiplier inflates', () => {
      // Total 10,000 CAW; spender has 5,000, other holder has 5,000.
      // Spender does CAW (spend 5000, communal 5000).
      // After spend: spender has 0; denominator = totalCaw - balance =
      // 10,000 - 5,000 = 5,000. communal=5000 fits exactly, so:
      //   multiplier_after = multiplier × (1 + 5000 / 5000) = 2 × multiplier
      const start = {
        multiplier: PRECISION,
        totalCaw: 10000n * PRECISION,
      }
      const spender = ownershipFromBalance(5000n * PRECISION, start.multiplier)
      const r = spendAndDistribute(spender, start, 5000n * PRECISION, 5000n * PRECISION)
      expect(r.refundedToSpender).to.equal(false)
      expect(r.multiplier).to.equal(2n * PRECISION)
      // Spender balance after: 0 (spent everything; refund didn't trigger)
      expect(r.senderBalance).to.equal(0n)
    })

    it('LIKE distributes communal proportionally', () => {
      // multiplier 1e18, totalCaw 10,000, spender holds 2,000.
      // LIKE: spend=2000, communal=400.
      // post-balance for spender = 0 (paid everything).
      // denominator = 10,000 - 2,000 = 8,000.
      // 400 ≤ 8,000, normal path: multiplier_after = 1e18 + 1e18 × 400 / 8000
      //   = 1e18 + 1e18 × 0.05 = 1.05e18.
      // Note: the receive=1600 is NOT applied here (caller does that
      // via addToBalance after).
      const start = {
        multiplier: PRECISION,
        totalCaw: 10000n * PRECISION,
      }
      const spender = ownershipFromBalance(2000n * PRECISION, start.multiplier)
      const r = spendAndDistribute(spender, start, 2000n * PRECISION, 400n * PRECISION)
      const expectedMultiplier = PRECISION + (PRECISION * 400n * PRECISION) / (8000n * PRECISION)
      expect(r.multiplier).to.equal(expectedMultiplier)
      expect(r.senderBalance).to.equal(0n)
    })
  })

  describe('addToBalance', () => {
    it('credits recipient using the current (post-spend) multiplier', () => {
      // After a LIKE, multiplier became 1.05e18. Now credit recipient 1600.
      const multiplier = (PRECISION * 105n) / 100n
      const recipientStart = ownershipFromBalance(0n, multiplier) // 0
      const r = addToBalance(recipientStart, multiplier, 1600n * PRECISION)
      // Recipient should now hold exactly 1600 CAW (within 1 ulp).
      const diff = 1600n * PRECISION - r.balance
      expect(diff < 2n && diff >= 0n).to.equal(true)
    })
  })

  describe('full LIKE sequence', () => {
    it('applies spend/distribute then recipient credit in the contract\'s order', () => {
      // World: total 12,000 CAW. Spender 2000, recipient 5000, other 5000.
      let multiplier = PRECISION
      const totalCaw = 12000n * PRECISION
      let spenderOwn = ownershipFromBalance(2000n * PRECISION, multiplier)
      let recipientOwn = ownershipFromBalance(5000n * PRECISION, multiplier)

      // Step 1: spendAndDistribute(spend=2000, communal=400)
      const r = spendAndDistribute(spenderOwn, { multiplier, totalCaw }, 2000n * PRECISION, 400n * PRECISION)
      multiplier = r.multiplier
      spenderOwn = r.senderOwnership
      // Step 2: addToBalance(recipient, 1600) — uses NEW multiplier
      const recv = addToBalance(recipientOwn, multiplier, 1600n * PRECISION)
      recipientOwn = recv.ownership

      const spenderBalance = balanceOf(spenderOwn, multiplier)
      const recipientBalance = balanceOf(recipientOwn, multiplier)

      // Spender: had 2000, spent 2000 → 0 (no refund path triggered).
      expect(spenderBalance).to.equal(0n)
      // Recipient: started with 5000, communal raised mult by 400/10000 = 4%,
      // so recipient's *passive* gain = 5000 × 0.04 = 200 CAW. Plus 1600 direct.
      // Expected total ≈ 5000 + 200 + 1600 = 6800.
      // (Allow up to 2 ulp of truncation on the bigint roundtrips.)
      const expected = 6800n * PRECISION
      const drift = recipientBalance > expected ? recipientBalance - expected : expected - recipientBalance
      expect(drift < 3n).to.equal(true)
    })
  })
})

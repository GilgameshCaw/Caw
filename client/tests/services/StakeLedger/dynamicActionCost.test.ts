// Tests for dynamic action-cost capping (getActionCost + recordAction's use
// of it via spendAndDistribute). Verifies NEW-32 against real incident data
// recorded in production (RewardMultiplierSnapshot for blocks 46314816 /
// 46321989 on cawnest.com, captured 2026-09-04). See NEW-32 investigation
// reports for full incident detail.
//
// The reproduction tests use a synthetic sender balance/ownership large
// enough to cover the spend, with totalCaw chosen so that
// (totalCaw - balance) exactly equals the denominator reverse-derived from
// the real (buggy) production multiplier transition — isolating the
// cost-calculation fix from unrelated totalCaw drift between the incident
// time and now (no historical totalCaw snapshot exists to read directly).

import { expect } from 'chai'
process.env.CLIENT_ID = '1'

import { getActionCost, CAP_STALE_THRESHOLD_SECONDS } from '../../../src/utils/cawActionCosts'
import { spendAndDistribute, PRECISION } from '../../../src/services/StakeLedger/contractMath'

const REAL_RATIO = 6790207473144214254423584n
const REAL_LAST_UPDATED = 1788325938n

describe('cawActionCosts / getActionCost — dynamic cap (NEW-32)', () => {
  it('returns baseline costs when capRatio is 0 (oracle dormant)', () => {
    const caw = getActionCost('CAW', 0n, 0n, 0n)
    const follow = getActionCost('FOLLOW', 0n, 0n, 0n)
    expect(caw).to.deep.equal({ spend: 5000n, communal: 5000n, receive: 0n })
    expect(follow).to.deep.equal({ spend: 30000n, communal: 6000n, receive: 24000n })
  })

  it('applies the dynamic cap when ratio is fresh (real on-chain ratio, block 46314816 timestamp)', () => {
    const blockSec = 1788397920n
    const caw = getActionCost('CAW', REAL_RATIO, REAL_LAST_UPDATED, blockSec)
    const follow = getActionCost('FOLLOW', REAL_RATIO, REAL_LAST_UPDATED, blockSec)
    expect(caw).to.deep.equal({ spend: 382n, communal: 382n, receive: 0n })
    expect(follow.communal).to.equal(458n)
  })

  it('falls back to baseline when the sample is stale (>24h)', () => {
    const staleSec = REAL_LAST_UPDATED + CAP_STALE_THRESHOLD_SECONDS + 1n
    const caw = getActionCost('CAW', REAL_RATIO, REAL_LAST_UPDATED, staleSec)
    expect(caw).to.deep.equal({ spend: 5000n, communal: 5000n, receive: 0n })
  })

  it('still applies the cap 1 second before the 24h stale boundary (block 46321989 near-miss)', () => {
    // Real incident #2: block timestamp 1788412266 vs oracle lastUpdatedAt
    // 1788325938 — an 86328s gap, only 72s inside the 86400s threshold.
    const nearStaleSec = 1788412266n
    const follow = getActionCost('FOLLOW', REAL_RATIO, REAL_LAST_UPDATED, nearStaleSec)
    expect(follow.communal).to.equal(458n)
  })

  it('reproduces incident #1 (block 46314816: CAW then FOLLOW, senderId=4) to within 1300 wei', () => {
    // denominator reverse-derived from the actual buggy production
    // multiplier transition recorded in RewardMultiplierSnapshot.
    const before1 = 1000047447554470150n
    const senderOwnership = 999952554696693462989702698648n
    const totalCaw1 = 1039102546981633772741084599107n // = denom1 + balanceOf(senderOwnership, before1)

    const caw = getActionCost('CAW', REAL_RATIO, REAL_LAST_UPDATED, 1788397920n)
    const r1 = spendAndDistribute(senderOwnership, { multiplier: before1, totalCaw: totalCaw1 }, caw.spend * PRECISION, caw.communal * PRECISION)

    const denom2 = 39102551981531843618974864124n
    const totalCaw2 = denom2 + r1.senderBalance

    const follow = getActionCost('FOLLOW', REAL_RATIO, REAL_LAST_UPDATED, 1788397920n)
    const r2 = spendAndDistribute(r1.senderOwnership, { multiplier: r1.multiplier, totalCaw: totalCaw2 }, follow.spend * PRECISION, follow.communal * PRECISION)

    const onchainTarget = 1000047469037465921n
    const diff = r2.multiplier > onchainTarget ? r2.multiplier - onchainTarget : onchainTarget - r2.multiplier
    // Old hardcoded-baseline bug produced a ~281B wei (13x) divergence here;
    // the fix lands within rounding distance of the real on-chain value.
    expect(diff).to.be.lessThan(1300n)
  })
})

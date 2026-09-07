/**
 * Tests for calculateTipCeilingFromOnChainTarget, the pure conversion function
 * backing useNetworkTipTargetAsCAW.
 *
 * Regression test for a unit-mismatch bug: networkTipTargetWei is
 * ETH-denominated (per CawActions.sol's "ethCap comes from
 * CawProfileLedger.networkTipTargetWei" comment on _getTipCost), but the
 * frontend previously divided it by 1e18 as if it were 18-decimal CAW-wei.
 * Since 500,000,000,000 / 1e18 == 0, the code fell back to a hardcoded
 * BigInt(1) (1 CAW) — far below the validator's 1000 CAW minimum implicit
 * session tip, causing every session-signed action to be rejected as
 * "underpriced" once the oracle first pushed a non-zero target (2026-09-04).
 *
 * Verified against real on-chain reads from cawnest.com's Base Sepolia RPC
 * (2026-09-07): CawProfileLedger.networkTipTargetWei(1) = 500000000000;
 * CawActions.tipState() = (lastUpdatedAt=1788639158, ratio=6790207473144214254423584).
 */

import { describe, it, expect } from 'vitest'
import { calculateTipCeilingFromOnChainTarget } from './useSessionKey'

// Real values read from cawnest.com's RPC, 2026-09-07.
const REAL_TIP_TARGET_WEI = 500000000000n
const REAL_TIP_RATIO = 6790207473144214254423584n
const REAL_LAST_UPDATED_AT = 1788639158n

describe('calculateTipCeilingFromOnChainTarget — QuickSign tip ceiling unit fix', () => {
  it('returns null (dormant) when tipTargetWei is 0', () => {
    const result = calculateTipCeilingFromOnChainTarget(0n, 0n, REAL_TIP_RATIO, REAL_LAST_UPDATED_AT + 100n)
    expect(result).toBeNull()
  })

  it('returns null (dormant) when tipRatio is 0', () => {
    const result = calculateTipCeilingFromOnChainTarget(REAL_TIP_TARGET_WEI, REAL_LAST_UPDATED_AT, 0n, REAL_LAST_UPDATED_AT + 100n)
    expect(result).toBeNull()
  })

  it('returns null (stale) when more than 24h have passed since lastUpdatedAt', () => {
    const justOverStale = REAL_LAST_UPDATED_AT + 86400n + 1n
    const result = calculateTipCeilingFromOnChainTarget(REAL_TIP_TARGET_WEI, REAL_LAST_UPDATED_AT, REAL_TIP_RATIO, justOverStale)
    expect(result).toBeNull()
  })

  it('does NOT treat exactly 24h as stale (boundary)', () => {
    const exactlyAtThreshold = REAL_LAST_UPDATED_AT + 86400n
    const result = calculateTipCeilingFromOnChainTarget(REAL_TIP_TARGET_WEI, REAL_LAST_UPDATED_AT, REAL_TIP_RATIO, exactlyAtThreshold)
    expect(result).not.toBeNull()
  })

  it('regression: real on-chain values no longer collapse to 1 CAW via naive /1e18 division', () => {
    // The pre-fix bug: 500_000_000_000n / 10n**18n === 0n, forced to BigInt(1).
    const naiveOldCalculation = REAL_TIP_TARGET_WEI / (10n ** 18n)
    expect(naiveOldCalculation).toBe(0n) // confirms the bug's premise

    // The fix converts via the on-chain ratio instead, and floors at the
    // validator's 1000 CAW minimum rather than silently defaulting to 1.
    const fresh = REAL_LAST_UPDATED_AT + 100n // well within the 24h window
    const result = calculateTipCeilingFromOnChainTarget(REAL_TIP_TARGET_WEI, REAL_LAST_UPDATED_AT, REAL_TIP_RATIO, fresh)
    expect(result).not.toBeNull()
    expect(result! >= 1000n).toBe(true)
  })

  it('computes the exact UQ112.112 conversion before applying the 1000 CAW floor', () => {
    // Raw conversion (ethCap << 112) / ratio / 1e18 = 382 for these real values —
    // itself below the validator floor, confirming the floor is load-bearing,
    // not just a defensive nicety.
    const fresh = REAL_LAST_UPDATED_AT + 100n
    const result = calculateTipCeilingFromOnChainTarget(REAL_TIP_TARGET_WEI, REAL_LAST_UPDATED_AT, REAL_TIP_RATIO, fresh)
    const rawConverted = (REAL_TIP_TARGET_WEI << 112n) / REAL_TIP_RATIO / (10n ** 18n)
    expect(rawConverted).toBe(382n)
    expect(result).toBe(1000n) // floored up from 382
  })
})

/**
 * Tests for the per-code invite-gift cap (MAX_INVITE_GIFT_CAW).
 *
 * The paid buy-a-code flow lets a user tip CAW to mint a single-use sponsor code
 * whose gift (= tip - gasMargin) becomes the maxDepositCawWei a redeemer can draw
 * into one new profile in one sponsored bootstrap. Without an upper bound, an
 * arbitrarily large tip mints a code that can drain the validator pool in a single
 * redemption — and can't be honoured in full anyway (it exceeds the bootstrap
 * path's SPONSOR_MAX_DEPOSIT_CAW). MAX_INVITE_GIFT_CAW closes that.
 *
 * These are dependency-light unit tests: MAX_INVITE_GIFT_CAW is a module-level
 * constant evaluated from env at import time, and quoteSponsorInviteCostCaw()
 * surfaces it on every path (including price-unavailable). We don't mock the price
 * caches — the cap is exposed regardless of price availability, which is exactly
 * what the FE clamp and the handler's reject-over-cap both rely on.
 */

import { describe, it } from 'mocha'
import { expect } from 'chai'

import { MAX_INVITE_GIFT_CAW, quoteSponsorInviteCostCaw } from '../../../src/services/SponsorService/inviteQuote'

describe('invite gift cap (MAX_INVITE_GIFT_CAW)', () => {
  it('defaults to 10M whole CAW when SPONSOR_MAX_DEPOSIT_CAW is unset', () => {
    // No env override is set in the test runner, so the default applies.
    expect(MAX_INVITE_GIFT_CAW).to.equal(10_000_000n)
  })

  it('is a positive bigint (never 0 / negative, which would block all codes)', () => {
    expect(MAX_INVITE_GIFT_CAW > 0n).to.equal(true)
  })

  it('quoteSponsorInviteCostCaw() always surfaces maxGiftCaw === MAX_INVITE_GIFT_CAW', () => {
    // Whether or not live prices are cached, the cap must be present so the FE can
    // clamp the input upper bound. With no price cache in the test process, this
    // exercises the price-unavailable branch specifically.
    const q = quoteSponsorInviteCostCaw()
    expect(q.maxGiftCaw).to.equal(MAX_INVITE_GIFT_CAW)
  })

  describe('cap predicate (mirrors handleSponsorInviteAction reject-over-cap)', () => {
    // The handler computes giftWholeCaw = max(0, tip - gasMargin) and rejects when
    // giftWholeCaw > MAX_INVITE_GIFT_CAW. These assert the boundary semantics the
    // handler + FE both enforce.
    const overCap = (gift: bigint) => gift > MAX_INVITE_GIFT_CAW

    it('accepts a gift exactly at the cap (inclusive boundary)', () => {
      expect(overCap(MAX_INVITE_GIFT_CAW)).to.equal(false)
    })

    it('accepts a gift just under the cap', () => {
      expect(overCap(MAX_INVITE_GIFT_CAW - 1n)).to.equal(false)
    })

    it('rejects a gift one over the cap', () => {
      expect(overCap(MAX_INVITE_GIFT_CAW + 1n)).to.equal(true)
    })

    it('rejects an astronomically large gift (the unbounded-tip attack)', () => {
      expect(overCap(10n ** 30n)).to.equal(true)
    })
  })
})

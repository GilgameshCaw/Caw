// services/SponsorService/inviteQuote.ts
//
// Pricing for the PAID sponsor-invite flow (buy-a-code). A buyer signs an
// on-chain OTHER action that tips CAW to a validator's profile; the tip must
// cover the validator's GAS + LZ relay cost to later honour the gift, and the
// remainder becomes the code's gift budget.
//
// This is the single source of truth for that pricing, shared by:
//   - GET /api/sponsor/invite-quote (FE: clamps the input, renders USD)
//   - handleSponsorInviteAction (server: gates the on-chain tip amount)
//
// All amounts are returned in WHOLE CAW (bigint), matching the on-chain
// recipients[]/amounts[] convention (amounts are whole CAW, scaled by 1e18
// on-chain). USD is derived from the cached chain prices.
//
// Auth/deposit/network storage fees are intentionally EXCLUDED: the sponsor
// redemption path is fee-free for authorized flows, so the only real cost is
// gas + the LZ relay leg.

import { getCawPriceCache, getEthPriceCache, getGasPriceCache } from '../ChainSyncService'

// Gas budget for the eventual sponsored mint (mirrors GAS_LIMIT_BOOTSTRAP_BUDGET
// in api/routes/sponsor.ts). The buyer pre-pays this so the validator is
// net-neutral when the code is later redeemed.
const GAS_LIMIT_BOOTSTRAP = 400_000n
// FALLBACK gas price used only when the live mainnet gas cache is unavailable.
// Conservative ceiling — a code minted against it is over-funded, never under.
const GAS_PRICE_FALLBACK_WEI = 20_000_000_000n // 20 gwei
// Safety multiplier on the live mainnet gas price: the code is redeemed LATER,
// so quote a hair above the current price to absorb minor drift between buy and
// redeem. 110% (×11/10 in bigint). Kept small on purpose — the quote already
// tracks live gas, so a large pad just over-charges the buyer.
const GAS_PRICE_SAFETY_NUM = 11n
const GAS_PRICE_SAFETY_DEN = 10n
// Treat a mainnet-gas cache older than this as unusable → fall back to the ceiling.
const MAX_GAS_AGE_MS = 15 * 60 * 1000 // 15 minutes
// LZ relay leg the validator fronts for the cross-chain deposit. Best-effort
// flat estimate (same order as the budget calc's lzFee assumption).
const LZ_RELAY_WEI = 1_000_000_000_000_000n // 0.001 ETH

/**
 * The gas price to quote against: the LIVE mainnet gas price (× safety margin)
 * when fresh, else the conservative fallback ceiling. The invite code pre-funds
 * a FUTURE mainnet redemption, so mainnet gas — not the ~0 testnet base fee — is
 * the correct basis. Never returns 0.
 */
function effectiveGasPriceWei(): bigint {
  const cache = getGasPriceCache()
  if (cache && cache.gasPriceWei > 0n && Date.now() - cache.updatedAt <= MAX_GAS_AGE_MS) {
    return (cache.gasPriceWei * GAS_PRICE_SAFETY_NUM) / GAS_PRICE_SAFETY_DEN
  }
  return GAS_PRICE_FALLBACK_WEI
}
// Reject prices older than this. A stale-low CAW price would let a buyer clear
// the gas floor with too little CAW and inflate the gift budget (M-2). Mirrors
// the contract's CAP_STALE_THRESHOLD intent.
const MAX_PRICE_AGE_MS = 15 * 60 * 1000 // 15 minutes

// Upper bound on a single code's gift (whole CAW). Without it, a buyer can tip an
// arbitrarily large amount and mint ONE single-use code whose maxDepositCawWei is
// unbounded — a redeemer then drains the whole gift into one new profile in a
// single sponsored bootstrap, fronted from the validator's pool. A gift larger
// than what one sponsored deposit can settle (SPONSOR_MAX_DEPOSIT_CAW, enforced
// at the bootstrap path in SponsorService) is also un-redeemable in full, so we
// cap the gift to the same ceiling. Defaults to 50M CAW (was 10M) so the cap can
// comfortably cover a 6-char username's 20M-CAW burn PLUS a real gift on top;
// overridable via the same env var so it stays aligned with SponsorService's
// maxDepositCAW.
export const MAX_INVITE_GIFT_CAW: bigint = (() => {
  const raw = process.env.SPONSOR_MAX_DEPOSIT_CAW
  if (raw) {
    try {
      const n = BigInt(raw)
      if (n > 0n) return n
    } catch { /* fall through to default */ }
  }
  return 50_000_000n // 50M whole CAW
})()

/**
 * Username BURN cost (whole CAW) for the shortest name a given min-length allows.
 * Mirrors CawProfileMinter.costOfName exactly. The sponsor fronts this burn at
 * redeem, so it's part of the invite's overhead. Only 6/7/8+ are offered to
 * sponsors (shorter names cost far more than a sponsored gift); a min-length
 * below 6 still maps to its real burn for safety.
 */
export function burnCostForLen(minLen: number): bigint {
  if (minLen <= 0) return 1_000_000n
  if (minLen === 1) return 1_000_000_000_000n
  if (minLen === 2) return 240_000_000_000n
  if (minLen === 3) return 60_000_000_000n
  if (minLen === 4) return 6_000_000_000n
  if (minLen === 5) return 200_000_000n
  if (minLen === 6) return 20_000_000n
  if (minLen === 7) return 10_000_000n
  return 1_000_000n // 8+
}

export interface InviteQuote {
  /** Minimum tip (whole CAW) that covers gas alone. Tip <= this => no code. */
  gasFloorCaw: bigint
  /** Tip overhead (whole CAW) deducted before the gift: gas + LZ relay. */
  gasMarginCaw: bigint
  /** Maximum gift (whole CAW) a single code may carry. A tip whose gift would
   *  exceed this is rejected by the handler (no code, no refund), so the FE
   *  should clamp the input's upper bound to (maxGiftCaw + gasMarginCaw). */
  maxGiftCaw: bigint
  /** USD per 1 whole CAW (float), for FE $ rendering. 0 when prices unknown. */
  cawUsdRate: number
  /** True when live prices were available; false => callers should treat the
   *  quote as unavailable rather than mint against a zero floor. */
  priceAvailable: boolean
}

/**
 * Convert a wei (ETH) amount to whole CAW using the cached cawPerEth rate.
 * cawPerEth is "CAW per 1 ETH, scaled by 1e18" (see ChainSyncService). So:
 *   wholeCaw = (weiEth / 1e18) * (cawPerEth / 1e18)
 * Done in bigint to avoid precision loss on large CAW magnitudes.
 */
function ethWeiToWholeCaw(weiEth: bigint, cawPerEth: bigint): bigint {
  // weiEth * cawPerEth has units (1e18 ETH-wei) * (1e18 CAW-per-ETH) = 1e36
  // scaled; divide by 1e36 to land on whole CAW.
  return (weiEth * cawPerEth) / (10n ** 36n)
}

// ─── executeBatch relay gas fee ──────────────────────────────────────────────
// Gas the validator/sponsor fronts when relaying a passkey-signed executeBatch
// (a self-custody withdraw or zap). The user must repay this in CAW inside the
// signed batch (a CAW.transfer to the relayer), or relaying is an open subsidy.
// Mirrors the GAS_LIMIT_EXECUTE_BATCH ceiling in SponsorService/index.ts.
const GAS_LIMIT_EXECUTE_BATCH = 800_000n

export interface ExecuteFeeQuote {
  /** Minimum CAW (wei, 18-dec) the batch must transfer to the relayer to cover
   *  the gas it fronts. 0n when prices are unavailable (caller must refuse). */
  minFeeCawWei: bigint
  /** True when live, non-stale prices backed the quote. */
  priceAvailable: boolean
}

/**
 * Minimum CAW (wei) an executeBatch must pay the relayer to make it whole for
 * what it fronts: the GAS to submit the tx PLUS any ETH `value` it forwards into
 * the batch (e.g. the withdraw's LayerZero fee). Priced from the cached CAW/ETH
 * rate with the same 15-min staleness guard as the invite quote. Pure read;
 * never throws. When prices are stale or unavailable, returns
 * priceAvailable=false / 0n so the relay refuses rather than fronts for free
 * (or, worse, prices against a stale-low rate so a dust CAW transfer clears it).
 *
 * SEAM-EXEC-2 (audit 2026-06-14): `forwardedValueWei` MUST be included. The
 * relayer attaches the batch's total inner call value as msg.value, so a withdraw
 * batch makes the relayer front the LZ fee (up to maxLzFeeWei). Pricing only gas
 * let a user relay a withdraw and get the LZ fee fronted for free — the exact
 * "relaying must stay financially viable" property leaking. The route passes the
 * batch's totalValue here so the CAW floor covers gas + forwarded ETH.
 *
 * Returned in wei-CAW (18-dec) — matching an on-chain ERC-20 `transfer` amount,
 * NOT whole CAW. cawPerEth is "CAW per 1 ETH scaled by 1e18", and the ETH cost is
 * in wei-ETH, so (ethCostWei * cawPerEth) / 1e18 lands on wei-CAW directly.
 */
export function quoteExecuteGasFeeCaw(forwardedValueWei: bigint = 0n, gasPriceWei?: bigint): ExecuteFeeQuote {
  const cawPrice = getCawPriceCache()
  const ethPrice = getEthPriceCache()

  if (!cawPrice || !ethPrice || cawPrice.cawPerEth <= 0n) {
    return { minFeeCawWei: 0n, priceAvailable: false }
  }
  const now = Date.now()
  if (now - cawPrice.updatedAt > MAX_PRICE_AGE_MS || now - ethPrice.updatedAt > MAX_PRICE_AGE_MS) {
    return { minFeeCawWei: 0n, priceAvailable: false }
  }

  const gasWei = (gasPriceWei ?? effectiveGasPriceWei()) * GAS_LIMIT_EXECUTE_BATCH
  // Relayer fronts gas AND the forwarded ETH value (the LZ fee on a withdraw).
  // Both must be repaid in CAW or relaying is a subsidy.
  const ethCostWei = gasWei + (forwardedValueWei > 0n ? forwardedValueWei : 0n)
  // wei-ETH * (CAW-per-ETH scaled 1e18) / 1e18 = wei-CAW.
  const minFeeCawWei = (ethCostWei * cawPrice.cawPerEth) / (10n ** 18n)
  return { minFeeCawWei, priceAvailable: true }
}

/**
 * Compute the invite-code pricing from cached chain prices. Pure read; never
 * throws. When prices are unavailable, returns priceAvailable=false with zero
 * amounts so callers can refuse rather than mint a free code.
 */
export function quoteSponsorInviteCostCaw(): InviteQuote {
  const cawPrice = getCawPriceCache()
  const ethPrice = getEthPriceCache()

  if (!cawPrice || !ethPrice || cawPrice.cawPerEth <= 0n) {
    return { gasFloorCaw: 0n, gasMarginCaw: 0n, maxGiftCaw: MAX_INVITE_GIFT_CAW, cawUsdRate: 0, priceAvailable: false }
  }

  // Reject stale prices — minting the gift against a stale-low CAW price is the
  // M-2 risk. Treat a too-old cache as unavailable so the handler skips the mint
  // and the FE refuses to clamp the input.
  const now = Date.now()
  if (now - cawPrice.updatedAt > MAX_PRICE_AGE_MS || now - ethPrice.updatedAt > MAX_PRICE_AGE_MS) {
    return { gasFloorCaw: 0n, gasMarginCaw: 0n, maxGiftCaw: MAX_INVITE_GIFT_CAW, cawUsdRate: 0, priceAvailable: false }
  }

  const gasWei = effectiveGasPriceWei() * GAS_LIMIT_BOOTSTRAP
  const gasFloorCaw = ethWeiToWholeCaw(gasWei, cawPrice.cawPerEth)
  const gasMarginCaw = ethWeiToWholeCaw(gasWei + LZ_RELAY_WEI, cawPrice.cawPerEth)

  // USD per CAW: ethPerCaw (wei per 1 CAW) -> ETH -> USD via usdPerEth (scaled 1e6).
  const ethPerCawFloat = Number(cawPrice.ethPerCaw) / 1e18
  const usdPerEthFloat = Number(ethPrice.usdPerEth) / 1e6
  const cawUsdRate = ethPerCawFloat * usdPerEthFloat

  return { gasFloorCaw, gasMarginCaw, maxGiftCaw: MAX_INVITE_GIFT_CAW, cawUsdRate, priceAvailable: true }
}

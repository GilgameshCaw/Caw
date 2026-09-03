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

import {
  getCawPriceCache, getEthPriceCache, getGasPriceCache, ensureFreshGasPriceCache,
  getLzDepositFeeCache, ensureFreshLzDepositFeeCache,
} from '../ChainSyncService'

// Gas budget for the eventual sponsored mint (mirrors GAS_LIMIT_BOOTSTRAP_BUDGET
// in api/routes/sponsor.ts). The buyer pre-pays this so the validator is
// net-neutral when the code is later redeemed.
const GAS_LIMIT_BOOTSTRAP = 400_000n
// LAST-RESORT fallback gas price, used ONLY when there's no mainnet RPC AND the
// on-demand fetch couldn't populate the cache (RPC down / not configured). The
// hot path now refreshes live gas on demand (ensureFreshGasPriceCache) rather
// than reaching for a constant, so this is a true degraded-mode floor — kept
// modest (3 gwei ≈ quiet mainnet) so a price outage doesn't massively over-charge
// a redeemer. It used to be 20 gwei, which over-deducted ~7× whenever the cache
// was momentarily cold.
const GAS_PRICE_FALLBACK_WEI = 3_000_000_000n // 3 gwei
// Safety multiplier on the live mainnet gas price: the code is redeemed LATER,
// so quote a hair above the current price to absorb minor drift between buy and
// redeem. 110% (×11/10 in bigint). Kept small on purpose — the quote already
// tracks live gas, so a large pad just over-charges the buyer.
const GAS_PRICE_SAFETY_NUM = 11n
const GAS_PRICE_SAFETY_DEN = 10n
// Treat a mainnet-gas cache older than this as unusable → fall back to the ceiling.
const MAX_GAS_AGE_MS = 15 * 60 * 1000 // 15 minutes
// LAST-RESORT fallback LZ relay fee, used ONLY when there's no L1 RPC AND the
// on-demand fetch couldn't populate the lzDepositFeeCache (RPC down / not
// configured). The hot path now quotes the LIVE LayerZero fee via
// CawProfile.lzQuote (see ChainSyncService's lzDepositFeeCache) rather than
// reaching for a constant, so this is a true degraded-mode floor. Measured real
// fee is ~0.0001 ETH; kept at 0.00015 ETH (50% above measured) rather than the
// old flat 0.001 ETH, which over-reserved by ~10x even in the degraded path.
const LZ_RELAY_FALLBACK_WEI = 150_000_000_000_000n // 0.00015 ETH
// Treat a live LZ-fee cache older than this as unusable → fall back to the floor.
const MAX_LZ_FEE_AGE_MS = 15 * 60 * 1000 // 15 minutes
// Safety pad on the live LZ quote: mirrors SponsorService's own 20% buffer on
// the SAME lzQuote call (absorbs fee drift between quote-time and the eventual
// real relay send). Applied whether the cache is fresh or merely stale — a
// recently-real quote is still a far better basis than the constant floor.
const LZ_FEE_SAFETY_NUM = 12n
const LZ_FEE_SAFETY_DEN = 10n

/**
 * Turn a (possibly null/stale) LZ deposit-fee cache into an effective wei fee:
 * the cached live quote × safety margin when present, else the degraded-mode
 * floor. Mirrors applyGasMargin() below. NEVER returns 0 — a manipulated or
 * degenerate 0-fee quote must still floor to something so the sponsor doesn't
 * under-reserve LZ overhead (adversarial-safety: a returned 0 nativeFee from a
 * misbehaving/misconfigured RPC must not zero out gasMarginCaw).
 */
function applyLzMargin(cache: { nativeFeeWei: bigint; updatedAt: number } | null): bigint {
  if (cache && cache.nativeFeeWei > 0n) {
    const padded = (cache.nativeFeeWei * LZ_FEE_SAFETY_NUM) / LZ_FEE_SAFETY_DEN
    return padded > 0n ? padded : LZ_RELAY_FALLBACK_WEI
  }
  // No live quote at all (no L1 RPC + refresh failed, or a 0/negative quote):
  // degraded floor so a price outage / bad quote doesn't zero out the reserve.
  return LZ_RELAY_FALLBACK_WEI
}

/**
 * The LZ relay fee to quote against (SYNC, cache-read only): the LIVE quoted
 * native fee (× safety margin) when cached, else the degraded floor. Never
 * returns 0. Prefer effectiveLzFeeWeiLive() on hot paths so a cold cache
 * triggers a real fetch instead of the floor.
 */
function effectiveLzFeeWei(): bigint {
  return applyLzMargin(getLzDepositFeeCache())
}

/**
 * Async variant of effectiveLzFeeWei() that REFRESHES the LZ deposit-fee cache
 * on demand when it's missing or stale, rather than falling back to the
 * degraded constant. Mirrors ensureFreshGasPriceCache's usage pattern — the
 * hot invite-quote ROUTE should call this (via quoteSponsorInviteCostCawLive
 * below) so a cold cache (e.g. right after a server restart) triggers one real
 * RPC quote instead of silently using the floor. Never throws; a failed
 * refresh degrades to the constant floor via applyLzMargin.
 */
async function effectiveLzFeeWeiLive(): Promise<bigint> {
  const cache = await ensureFreshLzDepositFeeCache(MAX_LZ_FEE_AGE_MS)
  return applyLzMargin(cache)
}

/**
 * Turn a (possibly null/stale) gas cache into an effective wei price: the cached
 * mainnet gas × safety margin when present, else the modest degraded-mode floor.
 * Shared by the sync (cache-read) and async (fetch-on-demand) entry points so
 * both apply the SAME margin + fallback. Stale caches still use the last KNOWN
 * price rather than the floor — a slightly stale real number beats a guess.
 */
function applyGasMargin(cache: { gasPriceWei: bigint; updatedAt: number } | null): bigint {
  if (cache && cache.gasPriceWei > 0n) {
    // Fresh OR stale: the last known real price × safety margin. (Stale is fine
    // here — a recently-real number is a far better basis than the floor; the
    // async entry point already tried to refresh before we got here.)
    return (cache.gasPriceWei * GAS_PRICE_SAFETY_NUM) / GAS_PRICE_SAFETY_DEN
  }
  // No gas data at all (no mainnet RPC + refresh failed): modest degraded floor
  // so a price outage doesn't massively over- or under-charge. Rare.
  return GAS_PRICE_FALLBACK_WEI
}

/**
 * The gas price to quote against (SYNC, cache-read only): the LIVE mainnet gas
 * price (× safety margin) when cached, else the degraded floor. The invite code
 * pre-funds a FUTURE mainnet redemption, so mainnet gas — not the ~0 testnet base
 * fee — is the correct basis. Never returns 0. Prefer the *Live variants below on
 * the hot redeem path so a cold cache triggers a real fetch instead of the floor.
 */
function effectiveGasPriceWei(): bigint {
  return applyGasMargin(getGasPriceCache())
}
// Reject prices older than this. A stale-low CAW price would let a buyer clear
// the gas floor with too little CAW and inflate the gift budget (M-2). Mirrors
// the contract's CAP_STALE_THRESHOLD intent.
const MAX_PRICE_AGE_MS = 15 * 60 * 1000 // 15 minutes

// Upper bound on a single code's gift, in WHOLE CAW. Without it, a buyer can tip
// an arbitrarily large amount and mint ONE single-use code whose maxDepositCawWei
// is unbounded — a redeemer then drains the whole gift into one new profile in a
// single sponsored bootstrap, fronted from the validator's pool. A gift larger
// than what one sponsored deposit can settle is also un-redeemable in full, so we
// cap the gift to the SAME ceiling SponsorService enforces.
//
// UNITS: SPONSOR_MAX_DEPOSIT_CAW is a WEI value (SponsorService reads it raw as
// wei, default 10M*1e18). This quote works in WHOLE CAW, so we divide by 1e18.
// (Reading it as whole CAW was a bug: it made the cap ~1e18× too large, so the
// FE never enforced a maximum.) Default 50M whole CAW when the env is unset.
export const MAX_INVITE_GIFT_CAW: bigint = (() => {
  const raw = process.env.SPONSOR_MAX_DEPOSIT_CAW
  if (raw) {
    try {
      const wei = BigInt(raw)
      const whole = wei / (10n ** 18n)
      if (whole > 0n) return whole
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
  /** The BINDING per-action cost (whole CAW) the invitee will actually pay:
   *  max(validator base tip in CAW, the validator's ETH-pegged min-tip floor
   *  converted to CAW). The FE divides the gift by this to show "~N actions".
   *  Using the base tip alone under-counts when the ETH floor is higher (the
   *  on-chain oracle converts that floor to CAW at submission). 0 if unknown. */
  perActionCaw: bigint
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

export interface ExecuteGasFeeEth {
  /** Minimum ETH (wei) the batch must transfer to the relayer to cover the gas it
   *  fronts. Used by the ETH-repay path (pay-with-ETH zap), where the relayer is
   *  repaid in ETH rather than CAW. Never null — gas is priced from the live
   *  mainnet gas cache (× safety margin) with the degraded-floor fallback, same as
   *  the invite quote; no CAW price needed, so this is always available. */
  minFeeEthWei: bigint
}

/**
 * The ETH (wei) the relayer must be repaid to cover the gas it fronts for an
 * executeBatch. The relayer fronts ONLY gas now (executeBatch is non-payable; the
 * EOA funds all inner-call value from its own balance — see relayExecuteBatch), so
 * this is purely gas. Padded the same way the invite quote pads gas (live mainnet
 * gas × safety margin, degraded floor on a cold cache). The pay-with-ETH batch
 * repays this via a raw ETH transfer to the relayer; the route verifies that leg
 * is ≥ this.
 */
export function quoteExecuteGasFeeEth(gasPriceWei?: bigint): ExecuteGasFeeEth {
  const gp = gasPriceWei ?? effectiveGasPriceWei()
  return { minFeeEthWei: gp * GAS_LIMIT_EXECUTE_BATCH }
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
  const minFeeCawWei = weiEthToWeiCaw(ethCostWei, cawPrice.cawPerEth)
  return { minFeeCawWei, priceAvailable: true }
}

/**
 * Convert a wei-ETH amount to wei-CAW (18-dec, matching an ERC-20 `transfer`
 * amount) using the cached cawPerEth rate ("CAW per 1 ETH", scaled by 1e18).
 * Shared by quoteExecuteGasFeeCaw and SponsorService.estimateExecuteFee so both
 * price a CAW repay against the EXACT same formula.
 */
export function weiEthToWeiCaw(weiEth: bigint, cawPerEth: bigint): bigint {
  // wei-ETH * (CAW-per-ETH scaled 1e18) / 1e18 = wei-CAW.
  return (weiEth * cawPerEth) / (10n ** 18n)
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
    return { gasFloorCaw: 0n, gasMarginCaw: 0n, maxGiftCaw: MAX_INVITE_GIFT_CAW, cawUsdRate: 0, perActionCaw: 0n, priceAvailable: false }
  }

  // Reject stale prices — minting the gift against a stale-low CAW price is the
  // M-2 risk. Treat a too-old cache as unavailable so the handler skips the mint
  // and the FE refuses to clamp the input.
  const now = Date.now()
  if (now - cawPrice.updatedAt > MAX_PRICE_AGE_MS || now - ethPrice.updatedAt > MAX_PRICE_AGE_MS) {
    return { gasFloorCaw: 0n, gasMarginCaw: 0n, maxGiftCaw: MAX_INVITE_GIFT_CAW, cawUsdRate: 0, perActionCaw: 0n, priceAvailable: false }
  }

  const gasWei = effectiveGasPriceWei() * GAS_LIMIT_BOOTSTRAP
  // gasFloorCaw = the LIVE redeem-gas estimate (whole CAW). Gas is now charged
  // at REDEEM (deducted from the gift when the invitee signs up), not pre-paid
  // by the buyer — so the validator is made whole against gas at the price that
  // exists when the code is actually used, not when it was bought.
  const gasFloorCaw = ethWeiToWholeCaw(gasWei, cawPrice.cawPerEth)
  // Purchase-time overhead the buyer pre-pays is now LZ-relay ONLY (no gas).
  // Uses the LIVE LayerZero quote (cached, refreshed on the price loop) rather
  // than a flat guess — the old flat 0.001 ETH constant was ~10x the real
  // ~0.0001 ETH fee, over-reserving the buyer's tip for no reason.
  const gasMarginCaw = ethWeiToWholeCaw(effectiveLzFeeWei(), cawPrice.cawPerEth)

  // USD per CAW: ethPerCaw (wei per 1 CAW) -> ETH -> USD via usdPerEth (scaled 1e6).
  const ethPerCawFloat = Number(cawPrice.ethPerCaw) / 1e18
  const usdPerEthFloat = Number(ethPrice.usdPerEth) / 1e6
  const cawUsdRate = ethPerCawFloat * usdPerEthFloat

  const perActionCaw = perActionCostCaw(cawPrice.cawPerEth)

  return { gasFloorCaw, gasMarginCaw, maxGiftCaw: MAX_INVITE_GIFT_CAW, cawUsdRate, perActionCaw, priceAvailable: true }
}

/**
 * Async variant of quoteSponsorInviteCostCaw() that REFRESHES the LZ
 * deposit-fee cache on demand (via effectiveLzFeeWeiLive) before computing the
 * quote, rather than reading whatever's cached. Mirrors redeemGasCostCawLive's
 * relationship to redeemGasCostCaw(). Use this from the GET /invite-quote
 * ROUTE (which is already async) for the freshest possible number; the
 * sync quoteSponsorInviteCostCaw() stays the version used by the indexer-side
 * handler (handleSponsorInvite.ts), which must stay a pure cache-read.
 */
export async function quoteSponsorInviteCostCawLive(): Promise<InviteQuote> {
  const cawPrice = getCawPriceCache()
  const ethPrice = getEthPriceCache()

  if (!cawPrice || !ethPrice || cawPrice.cawPerEth <= 0n) {
    return { gasFloorCaw: 0n, gasMarginCaw: 0n, maxGiftCaw: MAX_INVITE_GIFT_CAW, cawUsdRate: 0, perActionCaw: 0n, priceAvailable: false }
  }

  const now = Date.now()
  if (now - cawPrice.updatedAt > MAX_PRICE_AGE_MS || now - ethPrice.updatedAt > MAX_PRICE_AGE_MS) {
    return { gasFloorCaw: 0n, gasMarginCaw: 0n, maxGiftCaw: MAX_INVITE_GIFT_CAW, cawUsdRate: 0, perActionCaw: 0n, priceAvailable: false }
  }

  const gasWei = effectiveGasPriceWei() * GAS_LIMIT_BOOTSTRAP
  const gasFloorCaw = ethWeiToWholeCaw(gasWei, cawPrice.cawPerEth)
  const gasMarginCaw = ethWeiToWholeCaw(await effectiveLzFeeWeiLive(), cawPrice.cawPerEth)

  const ethPerCawFloat = Number(cawPrice.ethPerCaw) / 1e18
  const usdPerEthFloat = Number(ethPrice.usdPerEth) / 1e6
  const cawUsdRate = ethPerCawFloat * usdPerEthFloat

  const perActionCaw = perActionCostCaw(cawPrice.cawPerEth)

  return { gasFloorCaw, gasMarginCaw, maxGiftCaw: MAX_INVITE_GIFT_CAW, cawUsdRate, perActionCaw, priceAvailable: true }
}

/**
 * The LIVE redeem-gas cost in WHOLE CAW (wei-CAW / 1e18 rounded), or null if
 * prices are unavailable. This is what the sponsor server deducts from the gift
 * at redeem (deposit = pot − burn − this), so the validator recovers the ETH gas
 * it pays at the price that exists WHEN THE CODE IS USED. Computed server-side at
 * the bootstrap path; the FE reads it (echoed in /validate-code) only to render a
 * matching estimate — the server's value is authoritative.
 */
export function redeemGasCostCaw(): bigint | null {
  const cawPrice = getCawPriceCache()
  if (!cawPrice || cawPrice.cawPerEth <= 0n) return null
  const gasWei = effectiveGasPriceWei() * GAS_LIMIT_BOOTSTRAP
  return ethWeiToWholeCaw(gasWei, cawPrice.cawPerEth)
}

/**
 * Async variant of redeemGasCostCaw() that REFRESHES the mainnet gas cache on
 * demand when it's missing or stale, rather than falling back to the degraded
 * constant. This is the variant the hot redeem/preview path should use: a cold
 * cache (e.g. right after a server restart, before the 5-min price loop's first
 * tick) triggers one real RPC fetch instead of silently quoting the floor.
 * Concurrent calls dedupe onto a single in-flight fetch (ensureFreshGasPriceCache).
 * Returns null only when the CAW price itself is unavailable (same as the sync
 * version); a failed gas refresh degrades to the modest constant floor, not null.
 */
export async function redeemGasCostCawLive(): Promise<bigint | null> {
  const cawPrice = getCawPriceCache()
  if (!cawPrice || cawPrice.cawPerEth <= 0n) return null
  const cache = await ensureFreshGasPriceCache(MAX_GAS_AGE_MS)
  const gasWei = applyGasMargin(cache) * GAS_LIMIT_BOOTSTRAP
  return ethWeiToWholeCaw(gasWei, cawPrice.cawPerEth)
}

// Validator tip defaults — MIRROR validator-analytics.ts /tip-config so the
// "~N actions" estimate matches what an action will actually cost. The DB
// (validatorSetting) can override these at runtime; this pure quote uses the
// env/static fallback, which is correct unless an operator hand-tunes the DB
// rows (acceptable drift for an estimate).
const DEFAULT_VALIDATOR_BASE_TIP_CAW = 1000n
const DEFAULT_MIN_TIP_PER_ACTION_WEI = 450_000_000_000n // 4.5e11 wei ETH

/**
 * The BINDING per-action cost in whole CAW: the larger of (a) the validator's
 * flat CAW base tip and (b) its ETH-pegged per-action floor converted to CAW.
 * The on-chain cost oracle charges max(base, ETH-floor→CAW) per action, so the
 * floor — when higher — is what the invitee actually pays. Using only the base
 * tip over-counts the affordable actions (the bug behind "~9,833 actions" when
 * the ETH floor made each action ~50x the 1000-CAW base tip).
 */
function perActionCostCaw(cawPerEth: bigint): bigint {
  const baseTipCaw = (() => {
    try { return BigInt(process.env.VALIDATOR_BASE_TIP || DEFAULT_VALIDATOR_BASE_TIP_CAW.toString()) }
    catch { return DEFAULT_VALIDATOR_BASE_TIP_CAW }
  })()
  const minTipWei = (() => {
    try { return BigInt(process.env.MIN_TIP_PER_ACTION_WEI || DEFAULT_MIN_TIP_PER_ACTION_WEI.toString()) }
    catch { return DEFAULT_MIN_TIP_PER_ACTION_WEI }
  })()
  const floorCaw = ethWeiToWholeCaw(minTipWei, cawPerEth)
  return baseTipCaw > floorCaw ? baseTipCaw : floorCaw
}

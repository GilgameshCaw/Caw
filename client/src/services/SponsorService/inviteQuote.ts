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

import { getCawPriceCache, getEthPriceCache } from '../ChainSyncService'

// Gas budget for the eventual sponsored mint (mirrors GAS_LIMIT_BOOTSTRAP_BUDGET
// in api/routes/sponsor.ts). The buyer pre-pays this so the validator is
// net-neutral when the code is later redeemed.
const GAS_LIMIT_BOOTSTRAP = 400_000n
// Conservative gas price for the estimate (mirrors the budget calc). Testnet
// gas is free; on mainnet this is a realistic ceiling.
const GAS_PRICE_WEI = 20_000_000_000n // 20 gwei
// LZ relay leg the validator fronts for the cross-chain deposit. Best-effort
// flat estimate (same order as the budget calc's lzFee assumption).
const LZ_RELAY_WEI = 1_000_000_000_000_000n // 0.001 ETH

export interface InviteQuote {
  /** Minimum tip (whole CAW) that covers gas alone. Tip <= this => no code. */
  gasFloorCaw: bigint
  /** Tip overhead (whole CAW) deducted before the gift: gas + LZ relay. */
  gasMarginCaw: bigint
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

/**
 * Compute the invite-code pricing from cached chain prices. Pure read; never
 * throws. When prices are unavailable, returns priceAvailable=false with zero
 * amounts so callers can refuse rather than mint a free code.
 */
export function quoteSponsorInviteCostCaw(): InviteQuote {
  const cawPrice = getCawPriceCache()
  const ethPrice = getEthPriceCache()

  if (!cawPrice || !ethPrice || cawPrice.cawPerEth <= 0n) {
    return { gasFloorCaw: 0n, gasMarginCaw: 0n, cawUsdRate: 0, priceAvailable: false }
  }

  const gasWei = GAS_PRICE_WEI * GAS_LIMIT_BOOTSTRAP
  const gasFloorCaw = ethWeiToWholeCaw(gasWei, cawPrice.cawPerEth)
  const gasMarginCaw = ethWeiToWholeCaw(gasWei + LZ_RELAY_WEI, cawPrice.cawPerEth)

  // USD per CAW: ethPerCaw (wei per 1 CAW) -> ETH -> USD via usdPerEth (scaled 1e6).
  const ethPerCawFloat = Number(cawPrice.ethPerCaw) / 1e18
  const usdPerEthFloat = Number(ethPrice.usdPerEth) / 1e6
  const cawUsdRate = ethPerCawFloat * usdPerEthFloat

  return { gasFloorCaw, gasMarginCaw, cawUsdRate, priceAvailable: true }
}

// Live CAW/USD price helper for the installer.
//
// The CLI runs offline at install time — it has no price store like the FE's
// usePriceStore. But when the operator supplies an Infura key, we CAN derive a
// mainnet RPC URL and read the price the exact same way the backend does
// (client/src/services/ChainSyncService/index.ts): one mainnet Uniswap V2
// router call for CAW→WETH, a second for WETH→USDT. From those two reads we get
// USD-per-CAW and can convert a dollar target (e.g. "$0.10 per sponsored mint")
// into a raw-CAW-wei deposit figure to bake into client/.env.
//
// All addresses are mainnet constants, mirrored from ChainSyncService so the
// CLI's price matches what the running node will compute.

import { withProvider, infuraUrls } from './rpc.js'

// Mainnet constants — kept in sync with ChainSyncService/index.ts.
const MAINNET_CAW_ADDRESS = '0xf3b9569F82B18aEf890De263B84189bd33EBe452'
const MAINNET_WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const UNISWAP_V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'

const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
]

/**
 * Fetch the live USD price of 1 CAW from mainnet Uniswap V2.
 *
 * Returns a Number (USD per 1 whole CAW) — a tiny float like 3.8e-8 — or null
 * if the price couldn't be read (no Infura key, RPC error, empty pool). Callers
 * MUST handle null by falling back to a manual CAW-amount prompt.
 *
 * @param {object} ethers      The imported ethers module.
 * @param {string} mainnetUrl  Mainnet RPC URL (https://mainnet.infura.io/v3/<key>).
 * @param {string} [secret]    Optional Infura API Key Secret (Basic Auth).
 */
export async function fetchCawUsdPrice(ethers, mainnetUrl, secret) {
  if (!mainnetUrl) return null
  try {
    return await withProvider(ethers, mainnetUrl, secret, async (provider) => {
      const router = new ethers.Contract(UNISWAP_V2_ROUTER, ROUTER_ABI, provider)

      // 1) CAW → WETH. Quote 1M CAW for precision, same as ChainSyncService.
      const cawIn = 1_000_000n * 10n ** 18n
      const cawAmounts = await router.getAmountsOut(cawIn, [MAINNET_CAW_ADDRESS, MAINNET_WETH_ADDRESS])
      const ethOut = BigInt(cawAmounts[1])          // WETH wei for 1M CAW
      if (ethOut === 0n) return null

      // 2) WETH → USDT (6 decimals). Quote 1 WETH.
      const ethAmounts = await router.getAmountsOut(10n ** 18n, [MAINNET_WETH_ADDRESS, USDT_ADDRESS])
      const usdtPerEth = BigInt(ethAmounts[1])      // USDT (1e6) for 1 ETH
      if (usdtPerEth === 0n) return null

      // usdPerCaw = (ethOut / 1e18 / 1e6 CAW) * (usdtPerEth / 1e6) — done in float
      // since the result is a tiny fraction and we only need ~display precision.
      const ethPerCaw = Number(ethOut) / 1e18 / 1_000_000   // ETH per 1 CAW
      const usdPerEth = Number(usdtPerEth) / 1e6            // USD per 1 ETH
      const usdPerCaw = ethPerCaw * usdPerEth
      return Number.isFinite(usdPerCaw) && usdPerCaw > 0 ? usdPerCaw : null
    })
  } catch {
    return null
  }
}

/**
 * Convert a USD target into a whole-CAW integer at the given price.
 * Returns a BigInt count of whole CAW (NOT wei). e.g. $0.10 at $3.8e-8/CAW
 * ≈ 2,631,578 CAW.
 *
 * @param {number} usdTarget  Dollar amount (e.g. 0.10).
 * @param {number} usdPerCaw  USD price of 1 CAW (from fetchCawUsdPrice).
 */
export function usdToWholeCaw(usdTarget, usdPerCaw) {
  if (!usdPerCaw || usdPerCaw <= 0) return 0n
  const whole = Math.round(usdTarget / usdPerCaw)
  return BigInt(whole > 0 ? whole : 0)
}

/**
 * Derive the mainnet RPC URL from an Infura context ({ network, projectId }).
 * Price is ALWAYS read from real Ethereum mainnet, even on a testnet install —
 * testnet CAW has no meaningful USD value. Returns '' when no Infura key.
 */
export function mainnetUrlFromInfura(infura) {
  if (!infura || !infura.projectId) return ''
  const urls = infuraUrls('mainnet', 'ethMainnet', infura.projectId)
  return urls ? urls.http : ''
}

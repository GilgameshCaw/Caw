import { Router } from 'express'
import { getCawPriceCache, getEthPriceCache } from '../../services/ChainSyncService'

const router = Router()

/**
 * GET /api/prices
 * Returns cached CAW and ETH prices from Uniswap V2 pools
 */
router.get('/', (_req, res) => {
  const cawPrice = getCawPriceCache()
  const ethPrice = getEthPriceCache()

  if (!cawPrice || !ethPrice) {
    res.json({
      cawPerUsd: null,
      ethPerUsd: null,
      updatedAt: null,
    })
    return
  }

  // cawPrice.ethPerCaw is in wei per 1 CAW
  // ethPrice.usdPerEth is scaled by 1e6 (USDT decimals)
  // USD per CAW = ethPerCaw (in ETH) * usdPerEth
  const ethPerCaw = Number(cawPrice.ethPerCaw) / 1e18
  const usdPerEth = Number(ethPrice.usdPerEth) / 1e6
  const usdPerCaw = ethPerCaw * usdPerEth
  const cawPerUsd = usdPerCaw > 0 ? 1 / usdPerCaw : 0

  res.json({
    usdPerCaw,
    cawPerUsd,
    usdPerEth,
    updatedAt: Math.max(cawPrice.updatedAt, ethPrice.updatedAt),
  })
})

export default router

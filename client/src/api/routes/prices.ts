import { Router } from 'express'
import { getCawPriceCache, getEthPriceCache } from '../../services/ChainSyncService'
import { prisma } from '../../prismaClient'

const router = Router()

/**
 * GET /api/prices
 * Returns cached CAW and ETH prices from Uniswap V2 pools.
 * Tries in-memory cache first, falls back to DB.
 */
router.get('/', async (_req, res) => {
  let cawPrice = getCawPriceCache()
  let ethPrice = getEthPriceCache()

  // Fallback: read from DB if in-memory cache is empty
  if (!cawPrice || !ethPrice) {
    try {
      const [cawRow, ethRow] = await Promise.all([
        prisma.chainData.findUnique({ where: { key: 'caw_eth_price' } }),
        prisma.chainData.findUnique({ where: { key: 'eth_usd_price' } }),
      ])

      if (cawRow?.value && ethRow?.value) {
        const cawVal = cawRow.value as any
        const ethVal = ethRow.value as any
        cawPrice = {
          cawPerEth: BigInt(cawVal.cawPerEth),
          ethPerCaw: BigInt(cawVal.ethPerCaw),
          updatedAt: new Date(cawRow.updatedAt).getTime(),
        }
        ethPrice = {
          usdPerEth: BigInt(ethVal.usdPerEth),
          ethPerUsd: BigInt(ethVal.ethPerUsd),
          updatedAt: new Date(ethRow.updatedAt).getTime(),
        }
      }
    } catch (err) {
      console.warn('[Prices] Failed to read from DB:', err)
    }
  }

  if (!cawPrice || !ethPrice) {
    res.json({
      usdPerCaw: null,
      cawPerUsd: null,
      usdPerEth: null,
      updatedAt: null,
    })
    return
  }

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

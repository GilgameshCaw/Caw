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

/**
 * GET /api/prices/history?token=caw&period=24h
 * Returns price history for charting.
 * Supported periods: 1h, 6h, 24h, 7d, 30d, 90d
 */
router.get('/history', async (req, res) => {
  const token = (req.query.token as string) || 'caw'
  const period = (req.query.period as string) || '24h'

  const periodMs: Record<string, number> = {
    '1h':  60 * 60 * 1000,
    '6h':  6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d':  7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    '90d': 90 * 24 * 60 * 60 * 1000,
  }

  const ms = periodMs[period] || periodMs['24h']
  const since = new Date(Date.now() - ms)

  try {
    const snapshots = await prisma.priceSnapshot.findMany({
      where: {
        token,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        usdPrice: true,
        ethPrice: true,
        createdAt: true,
      },
    })

    res.json({ token, period, snapshots })
  } catch (err) {
    console.error('[Prices] Failed to fetch history:', err)
    res.status(500).json({ error: 'Failed to fetch price history' })
  }
})

/**
 * DELETE /api/prices/history/cleanup
 * Prune old price snapshots to save disk space.
 * Keeps 5-min granularity for 7 days, then thins to ~1 per hour.
 */
router.delete('/history/cleanup', async (_req, res) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

    // For data older than 7 days, keep only one snapshot per hour per token
    // Delete rows where minute != 0 and createdAt < 7 days ago
    const deleted = await prisma.$executeRaw`
      DELETE FROM "PriceSnapshot"
      WHERE "createdAt" < ${sevenDaysAgo}
      AND EXTRACT(MINUTE FROM "createdAt") != 0
    `

    res.json({ deleted })
  } catch (err) {
    console.error('[Prices] Failed to cleanup history:', err)
    res.status(500).json({ error: 'Failed to cleanup price history' })
  }
})

export default router

import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { requireAdmin } from '../middleware/auth'

const router = Router()

/**
 * GET /api/validator-analytics/tip-config
 * Public (no auth) — returns current tip settings so the frontend
 * can include the correct tip when signing actions.
 */
router.get('/tip-config', async (_req, res) => {
  try {
    const rows = await prisma.validatorSetting.findMany({
      where: { key: { in: ['validatorBaseTip'] } }
    })
    const map = new Map(rows.map(r => [r.key, r.value]))
    res.json({
      baseTip: map.get('validatorBaseTip') || process.env.VALIDATOR_BASE_TIP || '1000',
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// All remaining routes require admin auth
router.use(requireAdmin)

/**
 * GET /api/validator-analytics/summary?from=&to=
 * Aggregated stats for the time range
 */
router.get('/summary', async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from as string) : new Date(Date.now() - 7 * 86400000)
    const to = req.query.to ? new Date(req.query.to as string) : new Date()

    const txs = await prisma.validatorTx.findMany({
      where: { createdAt: { gte: from, lte: to }, status: 'confirmed' }
    })

    const totalActions = txs.reduce((s, t) => s + t.actionCount, 0)
    const totalEthCost = txs.reduce((s, t) => s + BigInt(t.ethCost), 0n)
    const totalTipCaw = txs.reduce((s, t) => s + BigInt(t.tipCaw), 0n)
    const totalTipEth = txs.reduce((s, t) => s + BigInt(t.tipEthValue), 0n)
    const totalProfit = txs.reduce((s, t) => s + BigInt(t.profit), 0n)
    const avgWaitMs = txs.length > 0
      ? Math.round(txs.reduce((s, t) => s + (t.avgWaitMs || 0), 0) / txs.length)
      : 0

    // Replication stats
    const replTxs = await prisma.replicationTx.findMany({
      where: { createdAt: { gte: from, lte: to }, status: 'confirmed' }
    })
    const totalReplCost = replTxs.reduce((s, t) => s + BigInt(t.totalCost), 0n)

    // Get latest prices for USD conversion
    const [ethPrice, cawPrice] = await Promise.all([
      prisma.priceSnapshot.findFirst({ where: { token: 'eth' }, orderBy: { createdAt: 'desc' } }),
      prisma.priceSnapshot.findFirst({ where: { token: 'caw' }, orderBy: { createdAt: 'desc' } }),
    ])
    const ethUsd = ethPrice?.usdPrice || 0
    const cawUsd = cawPrice?.usdPrice || 0

    res.json({
      transactions: txs.length,
      totalActions,
      totalEthCost: totalEthCost.toString(),
      totalTipCaw: totalTipCaw.toString(),
      totalTipEth: totalTipEth.toString(),
      totalProfit: totalProfit.toString(),
      avgActionsPerTx: txs.length > 0 ? (totalActions / txs.length).toFixed(1) : '0',
      avgWaitMs,
      prices: { ethUsd, cawUsd },
      replication: {
        transactions: replTxs.length,
        totalCost: totalReplCost.toString(),
        checkpointsReplicated: replTxs.length,
      }
    })
  } catch (err: any) {
    console.error('[validator-analytics] summary error:', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/validator-analytics/transactions?from=&to=&limit=50&offset=0
 */
router.get('/transactions', async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from as string) : new Date(Date.now() - 7 * 86400000)
    const to = req.query.to ? new Date(req.query.to as string) : new Date()
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)
    const offset = parseInt(req.query.offset as string) || 0

    const [txs, total] = await Promise.all([
      prisma.validatorTx.findMany({
        where: { createdAt: { gte: from, lte: to } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.validatorTx.count({
        where: { createdAt: { gte: from, lte: to } },
      }),
    ])

    // Serialize BigInt blockNumber
    const serialized = txs.map(t => ({
      ...t,
      blockNumber: t.blockNumber?.toString() ?? null,
    }))

    res.json({ transactions: serialized, total })
  } catch (err: any) {
    console.error('[validator-analytics] transactions error:', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/validator-analytics/replication?from=&to=&limit=50&offset=0
 */
router.get('/replication', async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from as string) : new Date(Date.now() - 7 * 86400000)
    const to = req.query.to ? new Date(req.query.to as string) : new Date()
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)
    const offset = parseInt(req.query.offset as string) || 0

    const [txs, total] = await Promise.all([
      prisma.replicationTx.findMany({
        where: { createdAt: { gte: from, lte: to } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.replicationTx.count({
        where: { createdAt: { gte: from, lte: to } },
      }),
    ])

    const serialized = txs.map(t => ({
      ...t,
      blockNumber: t.blockNumber?.toString() ?? null,
    }))

    res.json({ transactions: serialized, total })
  } catch (err: any) {
    console.error('[validator-analytics] replication error:', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/validator-analytics/chart?from=&to=&interval=day
 * Time-bucketed data for charting
 */
router.get('/chart', async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from as string) : new Date(Date.now() - 7 * 86400000)
    const to = req.query.to ? new Date(req.query.to as string) : new Date()
    const interval = (req.query.interval as string) || 'day'

    const validIntervals = ['hour', '6hour', 'day', 'week']
    if (!validIntervals.includes(interval)) {
      return res.status(400).json({ error: 'interval must be hour, 6hour, day, or week' })
    }

    // Accept optional timezone for local-time bucketing (e.g. 'America/New_York')
    const tz = (req.query.tz as string) || 'UTC'
    // Validate timezone name: only allow IANA-style identifiers
    if (!/^[A-Za-z_/+-]+$/.test(tz)) {
      return res.status(400).json({ error: 'invalid timezone' })
    }

    // For 6hour, floor the hour to the nearest 6-hour block (0, 6, 12, 18)
    const bucketExpr = interval === '6hour'
      ? `date_trunc('day', "createdAt" AT TIME ZONE $3) + (FLOOR(EXTRACT(HOUR FROM "createdAt" AT TIME ZONE $3) / 6) * INTERVAL '6 hours')`
      : `date_trunc('${interval}', "createdAt" AT TIME ZONE $3)`

    const rows: any[] = await prisma.$queryRawUnsafe(`
      SELECT
        ${bucketExpr} as bucket,
        TO_CHAR(${bucketExpr}, 'YYYY-MM-DD"T"HH24:MI:SS') as bucket_str,
        COUNT(*)::int as tx_count,
        SUM("actionCount")::int as action_count,
        SUM(CAST("ethCost" AS NUMERIC)) as total_eth_cost,
        SUM(CAST("tipCaw" AS NUMERIC)) as total_tip_caw,
        SUM(CAST("tipEthValue" AS NUMERIC)) as total_tip_eth,
        SUM(CAST("profit" AS NUMERIC)) as total_profit,
        AVG("avgWaitMs")::int as avg_wait_ms,
        jsonb_agg("actionBreakdown") FILTER (WHERE "actionBreakdown" IS NOT NULL) as breakdowns
      FROM "ValidatorTx"
      WHERE "createdAt" >= $1 AND "createdAt" <= $2 AND "status" = 'confirmed'
      GROUP BY bucket
      ORDER BY bucket ASC
    `, from, to, tz)

    // Merge per-tx breakdowns into a single aggregate per bucket
    function mergeBreakdowns(arr: Record<string, number>[] | null): Record<string, number> {
      const merged: Record<string, number> = {}
      if (!arr) return merged
      for (const bd of arr) {
        for (const [key, val] of Object.entries(bd)) {
          merged[key] = (merged[key] || 0) + Number(val)
        }
      }
      return merged
    }

    const chart = rows.map(r => ({
      time: r.bucket_str || r.bucket, // bucket_str is timezone-naive local time string
      txCount: Number(r.tx_count),
      actionCount: Number(r.action_count),
      ethCost: r.total_eth_cost?.toString() || '0',
      tipCaw: r.total_tip_caw?.toString() || '0',
      tipEth: r.total_tip_eth?.toString() || '0',
      profit: r.total_profit?.toString() || '0',
      avgWaitMs: Number(r.avg_wait_ms) || 0,
      actionBreakdown: mergeBreakdowns(r.breakdowns),
    }))

    res.json({ chart, interval })
  } catch (err: any) {
    console.error('[validator-analytics] chart error:', err)
    res.status(500).json({ error: err.message })
  }
})

// Valid config keys (whitelist)
const VALID_SETTINGS = [
  'validatorBaseTip',       // CAW per action
  'checkInterval',          // ms between polls
  'minActionsPerBatch',     // min actions before submitting
  'maxWaitTime',            // ms before force-submitting
  'replicationInterval',    // ms between replication checks
]

/**
 * GET /api/validator-analytics/settings
 */
router.get('/settings', async (req, res) => {
  try {
    const settings = await prisma.validatorSetting.findMany()
    const result: Record<string, string> = {}
    for (const s of settings) result[s.key] = s.value
    res.json(result)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * PATCH /api/validator-analytics/settings
 */
router.patch('/settings', async (req, res) => {
  try {
    const { key, value } = req.body
    if (!key || value === undefined) {
      return res.status(400).json({ error: 'key and value are required' })
    }
    if (!VALID_SETTINGS.includes(key)) {
      return res.status(400).json({ error: `Invalid setting key. Valid: ${VALID_SETTINGS.join(', ')}` })
    }

    await prisma.validatorSetting.upsert({
      where: { key },
      update: { value: String(value) },
      create: { key, value: String(value) },
    })

    res.json({ ok: true, key, value: String(value) })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

export default router

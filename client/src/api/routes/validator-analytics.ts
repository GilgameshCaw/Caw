import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { requireAdmin } from '../middleware/auth'

const router = Router()

/**
 * GET /api/validator-analytics/tip-config
 * Public (no auth) — returns current tip settings so the frontend
 * can include the correct tip when signing actions.
 */
// Default per-action ETH floor when the operator hasn't set a row yet.
// 272727272727 wei ≈ $0.0009/action at $3300/ETH. Picked so the FE
// "Tip / action" line shows a sensible cost out of the box; the operator
// can override via PATCH /api/validator-analytics/settings.
const DEFAULT_MIN_TIP_PER_ACTION_WEI = '272727272727'

router.get('/tip-config', async (_req, res) => {
  try {
    const rows = await prisma.validatorSetting.findMany({
      where: { key: { in: ['validatorBaseTip', 'priorityTip', 'minTipPerActionWei'] } }
    })
    const map = new Map(rows.map(r => [r.key, r.value]))
    const baseTip = map.get('validatorBaseTip') || process.env.VALIDATOR_BASE_TIP || '1000'
    res.json({
      baseTip,
      priorityTip: map.get('priorityTip') || String(BigInt(baseTip) * 3n),
      minTipPerActionWei: map.get('minTipPerActionWei')
        || process.env.MIN_TIP_PER_ACTION_WEI
        || DEFAULT_MIN_TIP_PER_ACTION_WEI,
    })
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' })
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
    res.status(500).json({ error: 'Internal server error' })
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
    res.status(500).json({ error: 'Internal server error' })
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
    res.status(500).json({ error: 'Internal server error' })
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
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return res.status(400).json({ error: 'invalid from/to date' })
    }
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

    // Timezone is validated above (IANA-style only) — safe to interpolate into SQL.
    // Using $3 parameterization for AT TIME ZONE causes issues when the expression
    // appears multiple times (bucket + TO_CHAR + GROUP BY), so we interpolate directly.
    const tzLiteral = tz.replace(/'/g, "''") // escape single quotes for SQL safety

    // ValidatorTx.createdAt is `timestamp without time zone` (Prisma's
    // default mapping for DateTime). The naked column stores UTC wall-clock,
    // so a bare `AT TIME ZONE '${tz}'` would invert the conversion (Postgres
    // would read the timestamp AS being in tz, then convert to UTC — the
    // opposite of what we want). Chain `AT TIME ZONE 'UTC' AT TIME ZONE tz`
    // to first attach UTC, then convert into the local tz for bucketing.
    const localCreatedAt = `("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE '${tzLiteral}')`

    // For 6hour, floor the hour to the nearest 6-hour block (0, 6, 12, 18)
    const bucketExpr = interval === '6hour'
      ? `date_trunc('day', ${localCreatedAt}) + (FLOOR(EXTRACT(HOUR FROM ${localCreatedAt}) / 6) * INTERVAL '6 hours')`
      : `date_trunc('${interval}', ${localCreatedAt})`

    // Inline ISO timestamps into the SQL — Prisma 6.18's $queryRawUnsafe
    // serializer rejects both Date objects and (oddly) string-encoded dates
    // when passed positionally for timestamptz columns. Date-string literals
    // are safe to interpolate here: from/to come from validated `new Date(...)`
    // calls so isNaN guards above ensure they're well-formed.
    const fromIso = from.toISOString()
    const toIso = to.toISOString()
    const rows: any[] = await prisma.$queryRawUnsafe(`
      SELECT
        bucket,
        TO_CHAR(bucket, 'YYYY-MM-DD"T"HH24:MI:SS') as bucket_str,
        tx_count,
        action_count,
        total_eth_cost,
        total_tip_caw,
        total_tip_eth,
        total_profit,
        avg_wait_ms,
        breakdowns
      FROM (
        SELECT
          ${bucketExpr} as bucket,
          COUNT(*)::int as tx_count,
          SUM("actionCount")::int as action_count,
          SUM(CAST("ethCost" AS NUMERIC)) as total_eth_cost,
          SUM(CAST("tipCaw" AS NUMERIC)) as total_tip_caw,
          SUM(CAST("tipEthValue" AS NUMERIC)) as total_tip_eth,
          SUM(CAST("profit" AS NUMERIC)) as total_profit,
          AVG("avgWaitMs")::int as avg_wait_ms,
          jsonb_agg("actionBreakdown") FILTER (WHERE "actionBreakdown" IS NOT NULL) as breakdowns
        FROM "ValidatorTx"
        WHERE "createdAt" AT TIME ZONE 'UTC' >= '${fromIso}'::timestamptz AND "createdAt" AT TIME ZONE 'UTC' <= '${toIso}'::timestamptz AND "status" = 'confirmed'
        GROUP BY bucket
      ) sub
      ORDER BY bucket ASC
    `)

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
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Valid config keys (whitelist)
const VALID_SETTINGS = [
  'validatorBaseTip',       // CAW per action — minimum tip to accept
  'priorityTip',            // CAW per action — actions ≥ this skip the batch wait
  'checkInterval',          // ms between polls
  'minActionsPerBatch',     // min actions before submitting
  'maxWaitTime',            // ms before force-submitting
  'replicationInterval',    // ms between replication checks
  'acceptZeroTip',          // boolean — opt into processing zero-tip actions
  // ETH-wei per-action floor published to /tip-config so the FE Quick Sign
  // step can render the "Tip / action" cost. Without a row here the FE shows
  // "—" and the validator imposes no per-action ETH floor. Task #169.
  'minTipPerActionWei',
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
    res.status(500).json({ error: 'Internal server error' })
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

    // Cross-key invariant: priorityTip must be >= validatorBaseTip. The FE
    // tier picker (Quick Sign Cheap vs Fast) signs actions at a tip that's
    // "at base for cheap, at priority for fast." If priority < base, every
    // Fast-tier action gets rejected as underpriced even though the user
    // explicitly opted into the higher cost — and worse, the cawonce can
    // get reused by a subsequent retry, leaving the original stranded.
    // Reported by Zin (2026-05-09).
    if (key === 'validatorBaseTip' || key === 'priorityTip') {
      const other = key === 'validatorBaseTip' ? 'priorityTip' : 'validatorBaseTip'
      const otherRow = await prisma.validatorSetting.findUnique({ where: { key: other } })
      if (otherRow) {
        try {
          const newVal = BigInt(value)
          const otherVal = BigInt(otherRow.value)
          const base = key === 'validatorBaseTip' ? newVal : otherVal
          const priority = key === 'priorityTip' ? newVal : otherVal
          if (priority < base) {
            return res.status(400).json({
              error: 'priority_below_base',
              message: `Priority Tip (${priority}) must be ≥ Base Validator Tip (${base}). The Fast-tier price can't be cheaper than the minimum the validator accepts.`,
            })
          }
        } catch {
          // BigInt parse failed; fall through and let the normal upsert
          // either store the bad value (and the FE will notice) or 500.
        }
      }
    }

    await prisma.validatorSetting.upsert({
      where: { key },
      update: { value: String(value) },
      create: { key, value: String(value) },
    })

    res.json({ ok: true, key, value: String(value) })
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router

// GET /api/users/:tokenId/caw-activity
//
// Per-user daily CAW flow page data: direct income/spend (from
// CawOwnershipSnapshot rows tagged ACTION_SENDER, ACTION_RECIPIENT,
// ACTION_VALIDATOR, DEPOSIT, WITHDRAW) plus communal income computed
// from RewardMultiplierSnapshot deltas joined laterally against the
// user's most-recent ownership-at-event-time.
//
// Auth-gated to the owner of :tokenId. Public-facing view of someone
// else's activity is a v2 concern.

import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { requireAuth } from '../middleware/auth'

const router = Router()

const VALID_INTERVALS = ['hour', '6hour', 'day', 'week'] as const
type Interval = (typeof VALID_INTERVALS)[number]

router.get(
  '/:tokenId/caw-activity',
  requireAuth({
    lookup: async (req) => {
      const raw = req.params.tokenId
      const n = raw ? Number(raw) : undefined
      return Number.isFinite(n) && n! > 0 ? n : undefined
    },
    verifyOwnership: true,
  }),
  async (req, res) => {
    try {
      const tokenId = Number(req.params.tokenId)
      const interval = ((req.query.interval as string) || 'day') as Interval
      if (!VALID_INTERVALS.includes(interval)) {
        return res.status(400).json({ error: 'interval must be hour, 6hour, day, or week' })
      }

      const tz = (req.query.tz as string) || 'UTC'
      if (!/^[A-Za-z_/+-]+$/.test(tz)) {
        return res.status(400).json({ error: 'invalid timezone' })
      }
      const tzLiteral = tz.replace(/'/g, "''")

      const from = req.query.from ? new Date(req.query.from as string) : new Date(Date.now() - 30 * 86400000)
      const to = req.query.to ? new Date(req.query.to as string) : new Date()
      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        return res.status(400).json({ error: 'invalid from/to' })
      }
      const fromIso = from.toISOString()
      const toIso = to.toISOString()

      const bucketExpr = (col: string) =>
        interval === '6hour'
          ? `date_trunc('day', ${col} AT TIME ZONE '${tzLiteral}') + (FLOOR(EXTRACT(HOUR FROM ${col} AT TIME ZONE '${tzLiteral}') / 6) * INTERVAL '6 hours')`
          : `date_trunc('${interval}', ${col} AT TIME ZONE '${tzLiteral}')`

      // -----------------------------------------------------------
      // Direct activity rows. balance/delta are stored as wei
      // (NUMERIC(78,0)); divide by 1e18 client-side to render whole
      // CAW. We split positive vs. negative so the chart can stack
      // earned above the baseline and spent below.
      // -----------------------------------------------------------
      const directRows: any[] = await prisma.$queryRawUnsafe(`
        SELECT
          TO_CHAR(${bucketExpr('"blockTimestamp"')}, 'YYYY-MM-DD"T"HH24:MI:SS') as bucket,
          "reason",
          "actionType",
          SUM(CASE WHEN CAST("delta" AS NUMERIC) > 0 THEN CAST("delta" AS NUMERIC) ELSE 0 END) as earned,
          SUM(CASE WHEN CAST("delta" AS NUMERIC) < 0 THEN -CAST("delta" AS NUMERIC) ELSE 0 END) as spent
        FROM "CawOwnershipSnapshot"
        WHERE "tokenId" = ${tokenId}
          AND "blockTimestamp" >= '${fromIso}'::timestamptz
          AND "blockTimestamp" <= '${toIso}'::timestamptz
        GROUP BY bucket, "reason", "actionType"
        ORDER BY bucket ASC
      `)

      // -----------------------------------------------------------
      // Communal income. For every multiplier change in the window,
      // find this user's most-recent ownership at that moment and
      // multiply by the multiplier delta. The lateral subquery keeps
      // the join cheap thanks to the (tokenId, blockTimestamp) index.
      // -----------------------------------------------------------
      const communalRows: any[] = await prisma.$queryRawUnsafe(`
        SELECT
          TO_CHAR(${bucketExpr('m."blockTimestamp"')}, 'YYYY-MM-DD"T"HH24:MI:SS') as bucket,
          SUM(
            CAST(o."ownership" AS NUMERIC)
              * (CAST(m."multiplierAfter" AS NUMERIC) - CAST(m."multiplierBefore" AS NUMERIC))
              / 1e18
          ) as communal
        FROM "RewardMultiplierSnapshot" m
        JOIN LATERAL (
          SELECT "ownership"
          FROM "CawOwnershipSnapshot"
          WHERE "tokenId" = ${tokenId}
            AND "blockTimestamp" <= m."blockTimestamp"
          ORDER BY "blockTimestamp" DESC
          LIMIT 1
        ) o ON true
        WHERE m."blockTimestamp" >= '${fromIso}'::timestamptz
          AND m."blockTimestamp" <= '${toIso}'::timestamptz
        GROUP BY bucket
        ORDER BY bucket ASC
      `)

      // -----------------------------------------------------------
      // Stitch buckets: union all bucket strings, then attach all
      // metric streams. Output keeps wei as strings (NUMERIC(78,0)
      // exceeds Number precision); FE divides by 1e18 once.
      // -----------------------------------------------------------
      const bucketKeys = new Set<string>()
      for (const r of directRows) bucketKeys.add(r.bucket)
      for (const r of communalRows) bucketKeys.add(r.bucket)
      const sortedBuckets = Array.from(bucketKeys).sort()

      type BucketAccum = {
        spent: bigint
        directEarned: bigint
        communalEarned: bigint
        deposits: bigint
        withdrawals: bigint
        breakdown: Record<string, bigint>
      }
      const buckets = new Map<string, BucketAccum>()
      for (const b of sortedBuckets) {
        buckets.set(b, {
          spent: 0n,
          directEarned: 0n,
          communalEarned: 0n,
          deposits: 0n,
          withdrawals: 0n,
          breakdown: {},
        })
      }

      const toBig = (v: any): bigint => {
        if (v == null) return 0n
        if (typeof v === 'bigint') return v
        const s = v.toString()
        // pg NUMERIC may come back like "1234567890123456789" or "1.23e+18"
        if (s.includes('.') || s.includes('e') || s.includes('E')) {
          // Floor truncate to int — wei has 18 decimals; intermediate
          // arithmetic may produce a small fractional remainder.
          return BigInt(Math.trunc(Number(s)))
        }
        return BigInt(s)
      }

      for (const r of directRows) {
        const acc = buckets.get(r.bucket)
        if (!acc) continue
        const earned = toBig(r.earned)
        const spent = toBig(r.spent)
        if (r.reason === 'DEPOSIT') {
          acc.deposits += earned
          acc.directEarned += earned
        } else if (r.actionType === 'WITHDRAW' && r.reason === 'ACTION_SENDER') {
          acc.withdrawals += spent
          // Withdrawals also count as "spent" in the chart's red bar
          acc.spent += spent
        } else if (r.reason === 'ACTION_SENDER') {
          acc.spent += spent
          // A sender row could in theory have a positive delta on the
          // refund-to-spender path; treat it as direct earnings.
          acc.directEarned += earned
        } else {
          // ACTION_RECIPIENT, ACTION_VALIDATOR, etc.
          acc.directEarned += earned
        }
        // Per-actionType breakdown for the tooltip. Use net delta
        // (earned - spent) so each row contributes once.
        if (r.actionType) {
          const net = earned - spent
          acc.breakdown[r.actionType] = (acc.breakdown[r.actionType] || 0n) + net
        }
      }
      for (const r of communalRows) {
        const acc = buckets.get(r.bucket)
        if (!acc) continue
        acc.communalEarned += toBig(r.communal)
      }

      // -----------------------------------------------------------
      // Summary: same numbers, integrated over the window.
      // -----------------------------------------------------------
      const summary = {
        totalSpent: 0n,
        directEarned: 0n,
        communalEarned: 0n,
        deposits: 0n,
        withdrawals: 0n,
      }
      for (const acc of buckets.values()) {
        summary.totalSpent += acc.spent
        summary.directEarned += acc.directEarned
        summary.communalEarned += acc.communalEarned
        summary.deposits += acc.deposits
        summary.withdrawals += acc.withdrawals
      }
      const net = summary.directEarned + summary.communalEarned - summary.totalSpent

      // Current stake share for context. (Fallback: 0/0 -> 0.)
      const [currentRow, stateRow] = await Promise.all([
        prisma.cawOwnershipCurrent.findUnique({ where: { tokenId } }),
        prisma.stakeLedgerState.findFirst(),
      ])
      let stakeShare = 0
      if (currentRow && stateRow) {
        const own = BigInt(currentRow.ownership)
        const total = BigInt(stateRow.totalCaw)
        if (total > 0n) {
          // Float-friendly: 6 decimals of precision should be plenty
          // for a ratio displayed as "x.xxxx%".
          const ratioE6 = (own * 1_000_000n) / total
          stakeShare = Number(ratioE6) / 1_000_000
        }
      }

      const stringify = (acc: BucketAccum) => ({
        spent: acc.spent.toString(),
        directEarned: acc.directEarned.toString(),
        communalEarned: acc.communalEarned.toString(),
        deposits: acc.deposits.toString(),
        withdrawals: acc.withdrawals.toString(),
        net: (acc.directEarned + acc.communalEarned - acc.spent).toString(),
        breakdown: Object.fromEntries(
          Object.entries(acc.breakdown).map(([k, v]) => [k, v.toString()]),
        ),
      })

      res.json({
        interval,
        summary: {
          totalSpent: summary.totalSpent.toString(),
          directEarned: summary.directEarned.toString(),
          communalEarned: summary.communalEarned.toString(),
          deposits: summary.deposits.toString(),
          withdrawals: summary.withdrawals.toString(),
          net: net.toString(),
          stakeShare,
        },
        chart: sortedBuckets.map(b => ({
          bucket: b,
          ...stringify(buckets.get(b)!),
        })),
      })
    } catch (err: any) {
      console.error('[caw-activity] error:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

export default router

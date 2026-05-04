// GET /api/users/:tokenId/caw-activity
//
// Per-user daily CAW flow page data:
//   - rewards (incoming) stack: direct receipts per actionType
//     (LIKE/RECAW/FOLLOW/TIP), validator fees received (validators
//     only), and "staking rewards" (communal income computed from
//     RewardMultiplierSnapshot deltas joined laterally against the
//     user's most-recent ownership-at-event-time).
//   - spend (outgoing) stack: per-actionType base costs, tips, and
//     the validator-fee component, grouped so the chart can stack.
//   - deposits / withdrawals: surfaced separately so they don't
//     dominate the activity-scale stacks.
//
// Public — every input here is on-chain anyway.

import { Router } from 'express'
import { prisma } from '../../prismaClient'

const router = Router()

const VALID_INTERVALS = ['hour', '6hour', 'day', 'week'] as const
type Interval = (typeof VALID_INTERVALS)[number]

router.get('/:tokenId/caw-activity', async (req, res) => {
  try {
    const tokenId = Number(req.params.tokenId)
    if (!Number.isFinite(tokenId) || tokenId <= 0 || !Number.isInteger(tokenId)) {
      return res.status(400).json({ error: 'tokenId must be a positive integer' })
    }
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

    // ---------------------------------------------------------------
    // Direct activity. Aggregates wei deltas per (bucket, reason,
    // actionType). The new ledger writes one row per touch component,
    // so the chart consumer can stack independently for incoming
    // (ACTION_RECIPIENT, ACTION_VALIDATOR) and outgoing
    // (ACTION_SPEND_BASE, ACTION_SPEND_TIP, ACTION_SPEND_VALIDATOR_TIP).
    // ---------------------------------------------------------------
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

    // ---------------------------------------------------------------
    // Communal income (staking rewards). For every multiplier change
    // in the window, find this user's most-recent ownership at that
    // moment and multiply by the multiplier delta.
    // ---------------------------------------------------------------
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

    // pg NUMERIC sometimes comes back as a string, sometimes as a
    // JS number in exponential notation. toBig coerces both.
    const toBig = (v: any): bigint => {
      if (v == null) return 0n
      if (typeof v === 'bigint') return v
      const s = v.toString()
      if (s.includes('.') || s.includes('e') || s.includes('E')) {
        return BigInt(Math.trunc(Number(s)))
      }
      return BigInt(s)
    }

    interface BucketAccum {
      // rewards (incoming): per-actionType direct credits + validator
      // fees received + staking rewards (communal).
      rewardsDirect: Record<string, bigint>
      rewardsValidatorFees: bigint
      rewardsStaking: bigint
      // spend (outgoing): per-actionType base costs, tips paid, and
      // validator-fee component.
      spendBase: Record<string, bigint>
      spendTips: Record<string, bigint>
      spendValidatorFees: bigint
      // bookkeeping.
      deposits: bigint
      withdrawals: bigint
    }
    const newAccum = (): BucketAccum => ({
      rewardsDirect: {},
      rewardsValidatorFees: 0n,
      rewardsStaking: 0n,
      spendBase: {},
      spendTips: {},
      spendValidatorFees: 0n,
      deposits: 0n,
      withdrawals: 0n,
    })
    const bumpMap = (m: Record<string, bigint>, key: string, delta: bigint) => {
      m[key] = (m[key] || 0n) + delta
    }

    const bucketKeys = new Set<string>()
    for (const r of directRows) bucketKeys.add(r.bucket)
    for (const r of communalRows) bucketKeys.add(r.bucket)
    const sortedBuckets = Array.from(bucketKeys).sort()

    const buckets = new Map<string, BucketAccum>()
    for (const b of sortedBuckets) buckets.set(b, newAccum())

    for (const r of directRows) {
      const acc = buckets.get(r.bucket)
      if (!acc) continue
      const earned = toBig(r.earned)
      const spent = toBig(r.spent)
      const reason = r.reason as string
      const actionType = (r.actionType as string | null) || 'OTHER'

      switch (reason) {
        case 'DEPOSIT':
          acc.deposits += earned
          break
        case 'WITHDRAW':
          // Legacy reason from earlier snapshots — equivalent to
          // ACTION_SPEND_BASE on a WITHDRAW action.
          acc.withdrawals += spent
          break
        case 'ACTION_SPEND_BASE':
          if (actionType === 'WITHDRAW') {
            acc.withdrawals += spent
          } else {
            bumpMap(acc.spendBase, actionType, spent)
          }
          // Refund-to-spender edge case: positive delta tagged as a
          // sender row. Lump back into staking rewards because that's
          // economically what happened.
          acc.rewardsStaking += earned
          break
        case 'ACTION_SPEND_TIP':
          bumpMap(acc.spendTips, actionType, spent)
          break
        case 'ACTION_SPEND_VALIDATOR_TIP':
          acc.spendValidatorFees += spent
          break
        case 'ACTION_RECIPIENT':
          bumpMap(acc.rewardsDirect, actionType, earned)
          break
        case 'ACTION_VALIDATOR':
          acc.rewardsValidatorFees += earned
          break
      }
    }
    for (const r of communalRows) {
      const acc = buckets.get(r.bucket)
      if (!acc) continue
      acc.rewardsStaking += toBig(r.communal)
    }

    // ---------------------------------------------------------------
    // Summary: integrate the per-bucket accums.
    // ---------------------------------------------------------------
    const summary = {
      rewardsDirect: 0n,
      rewardsValidatorFees: 0n,
      rewardsStaking: 0n,
      rewardsTotal: 0n,
      spendBase: 0n,
      spendTips: 0n,
      spendValidatorFees: 0n,
      spendTotal: 0n,
      deposits: 0n,
      withdrawals: 0n,
    }
    for (const acc of buckets.values()) {
      const directSum = Object.values(acc.rewardsDirect).reduce((a, b) => a + b, 0n)
      summary.rewardsDirect += directSum
      summary.rewardsValidatorFees += acc.rewardsValidatorFees
      summary.rewardsStaking += acc.rewardsStaking

      const baseSum = Object.values(acc.spendBase).reduce((a, b) => a + b, 0n)
      const tipSum = Object.values(acc.spendTips).reduce((a, b) => a + b, 0n)
      summary.spendBase += baseSum
      summary.spendTips += tipSum
      summary.spendValidatorFees += acc.spendValidatorFees

      summary.deposits += acc.deposits
      summary.withdrawals += acc.withdrawals
    }
    summary.rewardsTotal = summary.rewardsDirect + summary.rewardsValidatorFees + summary.rewardsStaking
    summary.spendTotal = summary.spendBase + summary.spendTips + summary.spendValidatorFees
    const net = summary.rewardsTotal - summary.spendTotal

    // Stake share for context (drives the APR estimate on the FE).
    const [currentRow, stateRow] = await Promise.all([
      prisma.cawOwnershipCurrent.findUnique({ where: { tokenId } }),
      prisma.stakeLedgerState.findFirst(),
    ])
    let stakeShare = 0
    if (currentRow && stateRow) {
      const own = BigInt(currentRow.ownership)
      const total = BigInt(stateRow.totalCaw)
      if (total > 0n) {
        const ratioE6 = (own * 1_000_000n) / total
        stakeShare = Number(ratioE6) / 1_000_000
      }
    }

    const mapToObj = (m: Record<string, bigint>): Record<string, string> =>
      Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.toString()]))

    res.json({
      interval,
      summary: {
        rewards: {
          total: summary.rewardsTotal.toString(),
          direct: summary.rewardsDirect.toString(),
          validatorFees: summary.rewardsValidatorFees.toString(),
          stakingRewards: summary.rewardsStaking.toString(),
        },
        spend: {
          total: summary.spendTotal.toString(),
          base: summary.spendBase.toString(),
          tips: summary.spendTips.toString(),
          validatorFees: summary.spendValidatorFees.toString(),
        },
        deposits: summary.deposits.toString(),
        withdrawals: summary.withdrawals.toString(),
        net: net.toString(),
        stakeShare,
      },
      chart: sortedBuckets.map(b => {
        const acc = buckets.get(b)!
        return {
          bucket: b,
          rewards: {
            direct: mapToObj(acc.rewardsDirect),
            validatorFees: acc.rewardsValidatorFees.toString(),
            stakingRewards: acc.rewardsStaking.toString(),
          },
          spend: {
            base: mapToObj(acc.spendBase),
            tips: mapToObj(acc.spendTips),
            validatorFees: acc.spendValidatorFees.toString(),
          },
          deposits: acc.deposits.toString(),
          withdrawals: acc.withdrawals.toString(),
        }
      }),
    })
  } catch (err: any) {
    console.error('[caw-activity] error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router

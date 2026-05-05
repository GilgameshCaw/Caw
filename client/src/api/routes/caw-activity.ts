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
import rateLimit from 'express-rate-limit'
import { prisma } from '../../prismaClient'

const router = Router()

const VALID_INTERVALS = ['hour', '6hour', 'day', 'week'] as const
type Interval = (typeof VALID_INTERVALS)[number]

// In-memory response cache.
//
// Purpose: protect the DB from request bursts. The lateral-join SQL
// for communal earnings is the most expensive query on this route —
// once per ActionsProcessed event in the window, ~10K events on a
// 30d window in a busy network. Without caching, a popular user's
// page reload + auto-refresh from many viewers would multiply that
// cost linearly.
//
// 30s TTL: the chart data is bucketed by hour at finest, so 30s of
// staleness is invisible to the user but cuts duplicate-request load
// by orders of magnitude. In-flight coalescing means N simultaneous
// requests for the same key share the same DB roundtrip.
//
// Per-process state — fine for now (one API process per host) and
// avoids needing Redis on a feature that's not yet load-bearing. Move
// to Redis if we shard the API.
interface CacheEntry {
  expiresAt: number
  body: any           // resolved JSON (also used for cache hits)
  inFlight?: Promise<any> // promise that resolves to `body` while still computing
}
const TTL_MS = 30_000
const CACHE_MAX = 1024 // bound memory; LRU-ish via oldest-key eviction
const responseCache = new Map<string, CacheEntry>()
const evictExpired = () => {
  const now = Date.now()
  for (const [k, v] of responseCache) {
    if (v.expiresAt < now && !v.inFlight) responseCache.delete(k)
  }
}
const cacheKeyOf = (
  tokenId: number,
  interval: Interval,
  tz: string,
  fromIso: string,
  toIso: string,
): string => `${tokenId}|${interval}|${tz}|${fromIso}|${toIso}`

// Rate limit: protects the DB from a single IP hammering the route.
// 30 rpm/IP is generous for human use (page load + auto-refresh +
// range-toggle clicks) and tight enough that a script can't blow up
// the lateral-join SQL. Cache hits don't count against the limit
// because the limit middleware runs BEFORE the route handler — so
// the cap is per-incoming-request regardless of cache state.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many activity requests, try again in a minute.' },
})

router.get('/:tokenId/caw-activity', limiter, async (req, res): Promise<void> => {
  // Holders for the cache machinery — populated once we have a valid
  // (tokenId, interval, tz, from, to). Used by both the success and
  // error paths so the coalesced waiters always get a resolution.
  let cacheKey: string | null = null
  let resolveInFlightOuter: (body: any) => void = () => {}
  let rejectInFlightOuter: (err: any) => void = () => {}
  try {
    const tokenId = Number(req.params.tokenId)
    if (!Number.isFinite(tokenId) || tokenId <= 0 || !Number.isInteger(tokenId)) {
      res.status(400).json({ error: 'tokenId must be a positive integer' }); return
    }
    const interval = ((req.query.interval as string) || 'day') as Interval
    if (!VALID_INTERVALS.includes(interval)) {
      res.status(400).json({ error: 'interval must be hour, 6hour, day, or week' }); return
    }
    const tz = (req.query.tz as string) || 'UTC'
    if (!/^[A-Za-z_/+-]+$/.test(tz)) {
      res.status(400).json({ error: 'invalid timezone' }); return
    }
    const tzLiteral = tz.replace(/'/g, "''")

    const from = req.query.from ? new Date(req.query.from as string) : new Date(Date.now() - 30 * 86400000)
    const to = req.query.to ? new Date(req.query.to as string) : new Date()
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      res.status(400).json({ error: 'invalid from/to' }); return
    }
    const fromIso = from.toISOString()
    const toIso = to.toISOString()

    // Cache hit / coalesce. A 30s TTL is invisible at chart bucket
    // resolution and folds bursty reloads into a single DB roundtrip.
    cacheKey = cacheKeyOf(tokenId, interval, tz, fromIso, toIso)
    const cached = responseCache.get(cacheKey)
    const now = Date.now()
    if (cached) {
      if (cached.inFlight) {
        try {
          const body = await cached.inFlight
          res.json(body); return
        } catch {
          // Original computation failed; fall through and recompute.
          responseCache.delete(cacheKey)
        }
      } else if (cached.expiresAt > now) {
        res.json(cached.body); return
      } else {
        responseCache.delete(cacheKey)
      }
    }
    if (responseCache.size >= CACHE_MAX) evictExpired()

    // Mark in-flight so concurrent identical requests share the work.
    const inFlight = new Promise<any>((resolve, reject) => {
      resolveInFlightOuter = resolve
      rejectInFlightOuter = reject
    })
    responseCache.set(cacheKey, { expiresAt: 0, body: null, inFlight })

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
        COUNT(*)::int as count_n,
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

    // ---------------------------------------------------------------
    // System-wide communal distribution (NOT user-scoped). Total CAW
    // distributed to all stakers per bucket, broken down by action
    // type. Same value for every viewer — answers "how much did the
    // protocol pay out" rather than "what did I get."
    // ---------------------------------------------------------------
    const distributionRows: any[] = await prisma.$queryRawUnsafe(`
      SELECT
        TO_CHAR(${bucketExpr('"blockTimestamp"')}, 'YYYY-MM-DD"T"HH24:MI:SS') as bucket,
        "actionType",
        SUM(CAST("communalAmount" AS NUMERIC)) as total
      FROM "RewardMultiplierSnapshot"
      WHERE "blockTimestamp" >= '${fromIso}'::timestamptz
        AND "blockTimestamp" <= '${toIso}'::timestamptz
      GROUP BY bucket, "actionType"
      ORDER BY bucket ASC
    `)

    // ---------------------------------------------------------------
    // Per-bucket end-of-period balance. For each bucket, take the
    // LAST CawOwnershipSnapshot.balance the user had in that bucket —
    // this is the chain-truth balance at the moment the bucket
    // closed. Buckets with no activity get null; the FE carries
    // forward from the prior bucket so the line stays continuous.
    // ---------------------------------------------------------------
    const balanceRows: any[] = await prisma.$queryRawUnsafe(`
      SELECT bucket, "balance"
      FROM (
        SELECT
          TO_CHAR(${bucketExpr('"blockTimestamp"')}, 'YYYY-MM-DD"T"HH24:MI:SS') as bucket,
          "balance",
          ROW_NUMBER() OVER (
            PARTITION BY ${bucketExpr('"blockTimestamp"')}
            ORDER BY "blockTimestamp" DESC, "id" DESC
          ) as rn
        FROM "CawOwnershipSnapshot"
        WHERE "tokenId" = ${tokenId}
          AND "blockTimestamp" >= '${fromIso}'::timestamptz
          AND "blockTimestamp" <= '${toIso}'::timestamptz
      ) ranked
      WHERE rn = 1
      ORDER BY bucket ASC
    `)

    // For buckets BEFORE the user's first ledger event in the window,
    // OR if no ledger rows exist in the window at all, we still want
    // a starting point: the most recent balance row at-or-before the
    // window start. Drives the leftmost point of the line graph.
    const priorBalanceRows: any[] = await prisma.$queryRawUnsafe(`
      SELECT "balance"
      FROM "CawOwnershipSnapshot"
      WHERE "tokenId" = ${tokenId}
        AND "blockTimestamp" < '${fromIso}'::timestamptz
      ORDER BY "blockTimestamp" DESC, "id" DESC
      LIMIT 1
    `)
    const balanceBeforeWindow: string | null =
      priorBalanceRows.length > 0 ? String(priorBalanceRows[0].balance) : null

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
      // Per-actionType count of incoming events (used for the
      // count-bar mini charts).
      rewardsDirectCounts: Record<string, number>
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
      rewardsDirectCounts: {},
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
    for (const r of distributionRows) bucketKeys.add(r.bucket)
    const sortedBuckets = Array.from(bucketKeys).sort()

    // System-wide distribution per bucket, by actionType. Same value
    // for every viewer — answers "how much did the protocol pay out
    // to all stakers" rather than "what did I personally get."
    const distributionByBucket = new Map<string, Record<string, bigint>>()
    for (const r of distributionRows) {
      const bucket = String(r.bucket)
      const actionType = (r.actionType as string | null) || 'OTHER'
      const total = toBig(r.total)
      const m = distributionByBucket.get(bucket) || {}
      m[actionType] = (m[actionType] || 0n) + total
      distributionByBucket.set(bucket, m)
    }

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
          acc.rewardsDirectCounts[actionType] =
            (acc.rewardsDirectCounts[actionType] || 0) + Number(r.count_n ?? 0)
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

    // Bucket -> end-of-period balance string. The chart consumer
    // carries forward through nulls so the line stays continuous in
    // quiet days.
    const balanceByBucket = new Map<string, string>()
    for (const r of balanceRows) {
      balanceByBucket.set(String(r.bucket), String(r.balance))
    }

    const body = {
      interval,
      balanceBeforeWindow,
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
            directCounts: acc.rewardsDirectCounts,
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
          balance: balanceByBucket.get(b) ?? null,
          distribution: mapToObj(distributionByBucket.get(b) || {}),
        }
      }),
    }
    // Cache the body for the TTL window. Resolve in-flight waiters so
    // they get the same payload without re-running the SQL.
    if (cacheKey) {
      responseCache.set(cacheKey, { expiresAt: Date.now() + TTL_MS, body, inFlight: undefined })
    }
    resolveInFlightOuter?.(body)
    res.json(body)
  } catch (err: any) {
    console.error('[caw-activity] error:', err)
    // Drop the failed cache entry and reject any coalesced waiters
    // so they retry on the next request rather than getting stuck.
    if (cacheKey) responseCache.delete(cacheKey)
    rejectInFlightOuter?.(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router

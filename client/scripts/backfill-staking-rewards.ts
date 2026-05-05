// scripts/backfill-staking-rewards.ts
//
// Backfill RewardMultiplierSnapshot rows from historical
// CawOwnershipSnapshot rows so the system-wide "CAW distributed to
// stakers" chart on the All Stats tab shows the full window. The
// live snapshotter only writes RewardMultiplierSnapshot for actions
// it processes; older actions never had a corresponding row.
//
// What we CAN backfill: communalAmount per action — derived from
// the static cost map (ACTION_COMMUNAL: CAW=5000, LIKE=400,
// RECAW=2000, FOLLOW=6000). The chart only reads communalAmount, so
// this fills in the historical visualization correctly.
//
// What we CANNOT backfill: multiplierBefore / multiplierAfter — the
// historical multiplier curve is unknowable from event logs alone
// (see earlier replay-then-reconcile attempt). My Stats per-user
// communal earnings (which read those fields via lateral join) stay
// 0 for backfilled rows. That's the deferred reconciliation problem.
//
// Idempotent on the (blockNumber, logIndex, actionIndex) PK — re-runs
// skip rows already present.
//
// Usage:
//   npx tsx scripts/backfill-staking-rewards.ts

import { prisma } from '../src/prismaClient'
import { ACTION_COST, type FixedCostActionType } from '../src/utils/cawActionCosts'

const PRECISION = 10n ** 18n
const FIXED_TYPES: FixedCostActionType[] = ['CAW', 'LIKE', 'RECAW', 'FOLLOW']
const COMMUNAL_E18: Record<FixedCostActionType, bigint> = {
  CAW: ACTION_COST.CAW.communal * PRECISION,
  LIKE: ACTION_COST.LIKE.communal * PRECISION,
  RECAW: ACTION_COST.RECAW.communal * PRECISION,
  FOLLOW: ACTION_COST.FOLLOW.communal * PRECISION,
}

function logProgress(msg: string) {
  console.log(`[staking-rewards-backfill] ${msg}`)
}

async function main() {
  // Pull every ACTION_SPEND_BASE row for a fixed-cost actionType.
  // These are the actions that triggered a communal distribution.
  // We use the existing CawOwnershipSnapshot row's identity to
  // reconstruct the matching RewardMultiplierSnapshot key.
  const types = FIXED_TYPES as readonly string[]
  logProgress(`scanning CawOwnershipSnapshot for ACTION_SPEND_BASE rows of types: ${types.join(', ')}`)

  const senderRows = await prisma.cawOwnershipSnapshot.findMany({
    where: {
      reason: 'ACTION_SPEND_BASE',
      actionType: { in: types as string[] },
    },
    select: {
      blockNumber: true,
      blockTimestamp: true,
      txHash: true,
      logIndex: true,
      actionIndex: true,
      actionType: true,
    },
    orderBy: [{ blockTimestamp: 'asc' }, { id: 'asc' }],
  })
  logProgress(`found ${senderRows.length} candidate row(s)`)

  // Pre-fetch existing keys so we can skip without N round-trips.
  const existing = await prisma.rewardMultiplierSnapshot.findMany({
    select: { blockNumber: true, logIndex: true, actionIndex: true },
  })
  const existingKey = new Set<string>()
  for (const e of existing) {
    existingKey.add(`${e.blockNumber}|${e.logIndex}|${e.actionIndex}`)
  }
  logProgress(`existing RewardMultiplierSnapshot rows: ${existing.length}`)

  // Build the inserts. The live snapshotter encodes actionIndex as
  // (parent_actionIndex × 16 + subActionIndex). We don't know
  // sub-action indices for historical rows, but the
  // (blockNumber, logIndex, actionIndex) tuple from
  // CawOwnershipSnapshot is unique per touch — using it directly is
  // fine for backfill since the live snapshotter will keep its
  // ×16+sub encoding for new rows and the two spaces don't collide
  // (actionIndex from snapshot rows is the unmultiplied index 0..N).
  // To keep the spaces disjoint (live: ×16+0..15, backfill: 0..),
  // we tag backfill rows with actionIndex = original × 16. That
  // matches the subActionIndex=0 slot the live snapshotter would
  // use for the type-specific spendAndDistribute call.
  const insertRows: any[] = []
  let skipped = 0
  for (const r of senderRows) {
    if (r.actionIndex == null) continue
    const liveActionIndex = r.actionIndex * 16
    const key = `${r.blockNumber}|${r.logIndex}|${liveActionIndex}`
    if (existingKey.has(key)) {
      skipped++
      continue
    }
    const communal = COMMUNAL_E18[r.actionType as FixedCostActionType]
    if (!communal) continue
    insertRows.push({
      blockNumber: r.blockNumber,
      txHash: r.txHash,
      logIndex: r.logIndex,
      actionIndex: liveActionIndex,
      blockTimestamp: r.blockTimestamp,
      // Multiplier values left at 0 — the All Stats chart only reads
      // communalAmount. Per-user My Stats lateral joins on these
      // would compute 0 communal earnings for historical days,
      // which is the honest answer (we don't know).
      multiplierBefore: '0',
      multiplierAfter: '0',
      communalAmount: communal.toString(),
      actionType: r.actionType,
    })
  }

  logProgress(`skipping ${skipped} already-present, inserting ${insertRows.length} new`)

  // Chunked insert. createMany is fastest; skipDuplicates handles any
  // race with the live snapshotter writing concurrently.
  const CHUNK = 1000
  let inserted = 0
  for (let i = 0; i < insertRows.length; i += CHUNK) {
    const chunk = insertRows.slice(i, i + CHUNK)
    const res = await prisma.rewardMultiplierSnapshot.createMany({
      data: chunk,
      skipDuplicates: true,
    })
    inserted += res.count
    logProgress(`  inserted ${inserted}/${insertRows.length}`)
  }

  logProgress(`Done. inserted=${inserted} skipped=${skipped} of ${senderRows.length} candidates.`)
  await prisma.$disconnect()
}

main().catch(err => {
  console.error('[staking-rewards-backfill] FAILED:', err)
  process.exit(1)
})

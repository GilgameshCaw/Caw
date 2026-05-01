// scripts/rescan-orphan-raw-events.ts
//
// Finds RawEvent rows from the CawActions contract that have no matching
// Action row, and reprocesses them through the same code path the live
// ActionProcessor uses. Mirrors handleRawAction in
// src/services/ActionProcessor/index.ts so behaviour is identical to a
// fresh indexer pass.
//
// Why this exists: the live ActionProcessor's catch block in handleRawAction
// swallows errors thrown from inside the prisma.$transaction call (e.g.
// CawNotFoundError when a like targets a caw whose own RawEvent hasn't been
// processed yet). The transaction rolls back, the Action row that was just
// created vanishes with it, and the outer loop advances `lastId` to the next
// raw event — the dropped event is silently lost. We've observed ~27% of
// CawActions raw events orphaned this way on test.caw.social.
//
// Run iteratively because orphan A may unblock orphan B (e.g. a like is
// orphaned because the target caw was also orphaned; once we reprocess the
// caw, the like succeeds on the next pass).
//
// Usage:
//   tsx scripts/rescan-orphan-raw-events.ts            # dry run, summary only
//   tsx scripts/rescan-orphan-raw-events.ts --apply    # actually reprocess
//   tsx scripts/rescan-orphan-raw-events.ts --apply --sender 78  # one user

import { prisma } from '../src/prismaClient'
import { CAW_ACTIONS_ADDRESS } from '../src/abi/addresses'
import { createOrFindAction, ensureActionExists } from '../src/services/ActionProcessor/actionCreation'
import { processDomainEffects, resolveActionUsers } from '../src/services/ActionProcessor/domainProcessor'
import { StaleTokenError } from '../src/services/UserService'
import getActionType from '../src/abi/getActionType'

const APPLY = process.argv.includes('--apply')
const senderArgIdx = process.argv.indexOf('--sender')
const SENDER_FILTER = senderArgIdx >= 0 ? Number(process.argv[senderArgIdx + 1]) : null

type OrphanRow = { id: number; chainId: number; data: any }

async function findOrphans(): Promise<OrphanRow[]> {
  const senderClause = SENDER_FILTER != null
    ? `AND (re.data->>'senderId')::int = ${SENDER_FILTER}`
    : ''
  const rows = await prisma.$queryRawUnsafe<OrphanRow[]>(`
    SELECT re.id, re."chainId", re.data
    FROM "RawEvent" re
    WHERE re."contractAddress" = '${CAW_ACTIONS_ADDRESS}'
      AND NOT EXISTS (SELECT 1 FROM "Action" a WHERE a."rawEventId" = re.id)
      ${senderClause}
    ORDER BY re.id ASC
  `)
  return rows
}

function summarize(orphans: OrphanRow[]) {
  const byType = new Map<string, number>()
  const bySender = new Map<number, number>()
  for (const o of orphans) {
    const list = Array.isArray(o.data) ? o.data : [o.data]
    for (const a of list) {
      const t = getActionType(Number(a.actionType))
      byType.set(t, (byType.get(t) || 0) + 1)
      const s = Number(a.senderId)
      bySender.set(s, (bySender.get(s) || 0) + 1)
    }
  }
  return { byType, bySender }
}

// Mirror of handleRawAction in src/services/ActionProcessor/index.ts —
// uses the same two-tx split so the Action row lands independently of
// domain side effects. Without that split, this script silently drops the
// same events the live indexer used to drop, leaving us back at square one.
//
// Result classes:
//   'created'      — Tx1 + Tx2 both succeeded.
//   'partial'      — Tx1 succeeded (Action row exists), Tx2 failed
//                    (domain side effects didn't land — typically a target
//                    that isn't on this client, or invalid action data).
//                    Not a regression: reprocessing the same rawId next
//                    pass will retry only Tx2 because shouldProcessDomain
//                    stays true until checkDomainObjectExists flips.
//   'skipped'      — StaleTokenError on the sender; nothing to do.
//   'failed'       — Tx1 failed for an unexpected reason. Inspect logs.
async function reprocessOne(rawId: number, chainId: number, rawAction: any): Promise<'created' | 'partial' | 'skipped' | 'failed'> {
  let resolved: Awaited<ReturnType<typeof resolveActionUsers>>
  try {
    resolved = await resolveActionUsers(rawAction)
  } catch (err: any) {
    if (err instanceof StaleTokenError) return 'skipped'
    return 'failed'
  }

  let action: any
  let shouldProcessDomain: boolean
  try {
    const result = await prisma.$transaction(async (tx) => {
      return await createOrFindAction(tx, rawId, chainId, rawAction)
    }, { timeout: 15_000 })
    action = result.action
    shouldProcessDomain = result.shouldProcessDomain
  } catch (err: any) {
    if (err.message?.includes('Action already exists (race condition)')) {
      const existing = await prisma.action.findFirst({
        where: { chainId, senderId: rawAction.senderId, cawonce: rawAction.cawonce },
      })
      if (!existing) return 'failed'
      action = existing
      shouldProcessDomain = true
    } else {
      return 'failed'
    }
  }

  if (!shouldProcessDomain) return 'created'

  try {
    await prisma.$transaction(async (tx) => {
      const validAction = await ensureActionExists(tx, rawId, action)
      await processDomainEffects(tx, validAction, rawAction, resolved)
    }, { timeout: 15_000 })
    return 'created'
  } catch {
    return 'partial'
  }
}

async function reprocessOrphan(o: OrphanRow): Promise<{ created: number; partial: number; skipped: number; failed: number }> {
  const list = Array.isArray(o.data) ? o.data : [o.data]
  const out = { created: 0, partial: 0, skipped: 0, failed: 0 }
  for (const a of list) {
    const r = await reprocessOne(o.id, o.chainId, a)
    out[r]++
  }
  return out
}

async function main() {
  console.log(`[Rescan] Mode: ${APPLY ? 'APPLY (will mutate)' : 'DRY RUN (read only)'}`)
  if (SENDER_FILTER != null) console.log(`[Rescan] Filter: senderId=${SENDER_FILTER}`)

  const before = await prisma.action.count()
  console.log(`[Rescan] Action rows before: ${before}`)

  const orphans = await findOrphans()
  console.log(`[Rescan] Orphan RawEvents: ${orphans.length}`)

  if (orphans.length === 0) {
    console.log('[Rescan] Nothing to do.')
    await prisma.$disconnect()
    return
  }

  const sum = summarize(orphans)
  console.log('\nBy action type:')
  for (const [t, n] of [...sum.byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(10)} ${n}`)
  }
  console.log('\nTop 10 affected senders:')
  for (const [s, n] of [...sum.bySender.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  sender=${s}  count=${n}`)
  }

  if (!APPLY) {
    console.log('\n[Rescan] Dry run complete. Re-run with --apply to reprocess.')
    await prisma.$disconnect()
    return
  }

  // Iterative passes — some orphans depend on others, so retry until no
  // progress is made.
  let pass = 0
  let prevRemaining = orphans.length + 1
  while (true) {
    pass++
    const remaining = await findOrphans()
    if (remaining.length === 0) {
      console.log(`\n[Rescan] All orphans resolved after ${pass - 1} pass(es).`)
      break
    }
    if (remaining.length >= prevRemaining) {
      console.log(`\n[Rescan] Pass ${pass}: ${remaining.length} orphans remain — no progress on previous pass, stopping.`)
      break
    }
    prevRemaining = remaining.length
    console.log(`\n[Rescan] Pass ${pass}: reprocessing ${remaining.length} orphan(s)...`)
    const totals = { created: 0, partial: 0, skipped: 0, failed: 0 }
    for (let i = 0; i < remaining.length; i++) {
      const o = remaining[i]
      const r = await reprocessOrphan(o)
      totals.created += r.created
      totals.partial += r.partial
      totals.skipped += r.skipped
      totals.failed += r.failed
      if ((i + 1) % 100 === 0) {
        console.log(`  ...${i + 1}/${remaining.length} (created=${totals.created} partial=${totals.partial} skipped=${totals.skipped} failed=${totals.failed})`)
      }
    }
    console.log(`[Rescan] Pass ${pass} complete: created=${totals.created} partial=${totals.partial} skipped=${totals.skipped} failed=${totals.failed}`)
  }

  const after = await prisma.action.count()
  console.log(`\n[Rescan] Action rows after:  ${after} (delta +${after - before})`)

  const stillOrphan = await findOrphans()
  if (stillOrphan.length > 0) {
    console.log(`[Rescan] ${stillOrphan.length} RawEvent(s) still orphaned (likely targets unknown caws / stale tokens / other-client targets).`)
  }

  await prisma.$disconnect()
}

main().catch(err => {
  console.error('[Rescan] Fatal:', err)
  process.exit(1)
})

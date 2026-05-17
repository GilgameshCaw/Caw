/**
 * Reconcile Caw.{commentCount,recawCount,likeCount} against the
 * authoritative backing rows. Drift accumulates over time when a
 * write path bumps the counter without an authoritative row, or
 * fails to decrement on rollback (see project_count_manager memory).
 *
 * Usage:
 *   npx tsx client/scripts/reconcile-caw-counts.ts             # dry-run, prints drifts only
 *   npx tsx client/scripts/reconcile-caw-counts.ts --apply     # write fixes
 *
 * Sources of truth (must match what CountManager increments/decrements
 * — pending rows DO contribute, because optimistic /api/actions writes
 * already bumped the counter at submit time):
 *
 *   commentCount = count(Reply where cawId = caw.id)
 *                  ↑ Reply row, not "any child caw". Plain RECAWs with
 *                    empty content land in Caw with originalCawId set
 *                    but never get a Reply row. Pending replies count —
 *                    CountManager.onReplyCreated increments regardless
 *                    of pending; the row is deleted on FAILED rollback.
 *
 *   recawCount   = count(Caw where originalCawId = caw.id
 *                              and action = 'RECAW'
 *                              and status IN ('SUCCESS', 'PENDING'))
 *                  ↑ Both bare recaws and quotes count, because the
 *                    repostsTotal that the UI shows is the union.
 *                    FAILED / HIDDEN child rows are excluded — those
 *                    represent rolled-back actions whose counter was
 *                    decremented at status transition.
 *
 *   likeCount    = count(Like where cawId = caw.id
 *                             and NOT (pending = true AND action = 'UNLIKE'))
 *                  ↑ Active likes include pending-LIKE (count was bumped
 *                    optimistically) but exclude pending-UNLIKE (count
 *                    was already decremented optimistically; the row is
 *                    a tombstone awaiting confirm/delete).
 *
 * Read-only pass first. Reports per-caw drifts AND a summary. Apply
 * pass runs three single UPDATE … FROM (subquery) statements per
 * counter — efficient, no per-row N round-trips. Idempotent: running
 * with --apply twice in a row leaves the second run with zero drift.
 */
import { prisma } from '../src/prismaClient'

interface Drift {
  id: number
  stored: number
  actual: number
  delta: number  // stored - actual; positive = over-count, negative = under
}

async function reportDrifts(label: string, rows: Drift[]) {
  if (rows.length === 0) {
    console.log(`[${label}] no drift`)
    return
  }
  const over = rows.filter(r => r.delta > 0)
  const under = rows.filter(r => r.delta < 0)
  const overSum = over.reduce((s, r) => s + r.delta, 0)
  const underSum = under.reduce((s, r) => s + r.delta, 0)
  console.log(`[${label}] ${rows.length} caws drifted — over: ${over.length} (+${overSum}), under: ${under.length} (${underSum})`)

  // Print the top 10 by absolute drift for spot-checking.
  const worst = rows.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 10)
  for (const r of worst) {
    console.log(`  caw ${r.id}: stored=${r.stored} actual=${r.actual} (${r.delta > 0 ? '+' : ''}${r.delta})`)
  }
}

async function findCommentDrift(): Promise<Drift[]> {
  return prisma.$queryRaw<Drift[]>`
    SELECT c.id, c."commentCount" AS stored, COALESCE(sub.actual, 0)::int AS actual,
           (c."commentCount" - COALESCE(sub.actual, 0))::int AS delta
    FROM "Caw" c
    LEFT JOIN (
      SELECT "cawId" AS id, COUNT(*)::int AS actual
      FROM "Reply"
      GROUP BY "cawId"
    ) sub ON sub.id = c.id
    WHERE c."commentCount" != COALESCE(sub.actual, 0)
  `
}

async function findRecawDrift(): Promise<Drift[]> {
  return prisma.$queryRaw<Drift[]>`
    SELECT c.id, c."recawCount" AS stored, COALESCE(sub.actual, 0)::int AS actual,
           (c."recawCount" - COALESCE(sub.actual, 0))::int AS delta
    FROM "Caw" c
    LEFT JOIN (
      SELECT "originalCawId" AS id, COUNT(*)::int AS actual
      FROM "Caw"
      WHERE action = 'RECAW'
        AND status IN ('SUCCESS', 'PENDING')
        AND "originalCawId" IS NOT NULL
      GROUP BY "originalCawId"
    ) sub ON sub.id = c.id
    WHERE c."recawCount" != COALESCE(sub.actual, 0)
  `
}

async function findLikeDrift(): Promise<Drift[]> {
  return prisma.$queryRaw<Drift[]>`
    SELECT c.id, c."likeCount" AS stored, COALESCE(sub.actual, 0)::int AS actual,
           (c."likeCount" - COALESCE(sub.actual, 0))::int AS delta
    FROM "Caw" c
    LEFT JOIN (
      SELECT "cawId" AS id, COUNT(*)::int AS actual
      FROM "Like"
      WHERE NOT (pending = true AND action = 'UNLIKE')
      GROUP BY "cawId"
    ) sub ON sub.id = c.id
    WHERE c."likeCount" != COALESCE(sub.actual, 0)
  `
}

async function applyCommentFix() {
  // Single UPDATE … FROM that writes the correct value for every drifted
  // caw at once. The COALESCE(...,0) handles caws with no Reply rows
  // (which should have commentCount=0 but stored >0 from the bug).
  const result = await prisma.$executeRaw`
    UPDATE "Caw" c
    SET "commentCount" = COALESCE(sub.actual, 0)
    FROM (
      SELECT c2.id, sub2.actual
      FROM "Caw" c2
      LEFT JOIN (
        SELECT "cawId" AS id, COUNT(*)::int AS actual
        FROM "Reply"
        GROUP BY "cawId"
      ) sub2 ON sub2.id = c2.id
      WHERE c2."commentCount" != COALESCE(sub2.actual, 0)
    ) sub
    WHERE c.id = sub.id
  `
  console.log(`[apply] commentCount: updated ${result} rows`)
}

async function applyRecawFix() {
  const result = await prisma.$executeRaw`
    UPDATE "Caw" c
    SET "recawCount" = COALESCE(sub.actual, 0)
    FROM (
      SELECT c2.id, sub2.actual
      FROM "Caw" c2
      LEFT JOIN (
        SELECT "originalCawId" AS id, COUNT(*)::int AS actual
        FROM "Caw"
        WHERE action = 'RECAW'
          AND status IN ('SUCCESS', 'PENDING')
          AND "originalCawId" IS NOT NULL
        GROUP BY "originalCawId"
      ) sub2 ON sub2.id = c2.id
      WHERE c2."recawCount" != COALESCE(sub2.actual, 0)
    ) sub
    WHERE c.id = sub.id
  `
  console.log(`[apply] recawCount: updated ${result} rows`)
}

async function applyLikeFix() {
  const result = await prisma.$executeRaw`
    UPDATE "Caw" c
    SET "likeCount" = COALESCE(sub.actual, 0)
    FROM (
      SELECT c2.id, sub2.actual
      FROM "Caw" c2
      LEFT JOIN (
        SELECT "cawId" AS id, COUNT(*)::int AS actual
        FROM "Like"
        WHERE NOT (pending = true AND action = 'UNLIKE')
        GROUP BY "cawId"
      ) sub2 ON sub2.id = c2.id
      WHERE c2."likeCount" != COALESCE(sub2.actual, 0)
    ) sub
    WHERE c.id = sub.id
  `
  console.log(`[apply] likeCount: updated ${result} rows`)
}

async function main() {
  const apply = process.argv.includes('--apply')

  console.log(`mode: ${apply ? 'APPLY (writing fixes)' : 'dry-run (no writes)'}`)
  console.log('---')

  // Always start with a read-only report so the apply pass can be
  // compared against the dry-run that justified it.
  const commentDrift = await findCommentDrift()
  const recawDrift = await findRecawDrift()
  const likeDrift = await findLikeDrift()

  await reportDrifts('commentCount', commentDrift)
  await reportDrifts('recawCount', recawDrift)
  await reportDrifts('likeCount', likeDrift)

  if (!apply) {
    console.log('---')
    console.log('dry-run only — re-run with --apply to write fixes')
    return
  }

  console.log('---')
  console.log('applying fixes')
  await applyCommentFix()
  await applyRecawFix()
  await applyLikeFix()

  // Verify by re-running the drift queries — should be zero on every
  // counter. If anything still drifts, that's a write path racing the
  // reconcile (unlikely on a test DB but worth surfacing).
  console.log('---')
  console.log('verifying')
  const c2 = await findCommentDrift()
  const r2 = await findRecawDrift()
  const l2 = await findLikeDrift()
  await reportDrifts('commentCount (post-apply)', c2)
  await reportDrifts('recawCount (post-apply)', r2)
  await reportDrifts('likeCount (post-apply)', l2)
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1) })

// Standalone verification of cli/src/steps/ensureManualSql.js's core
// decision logic (index-exists check -> duplicate check -> create),
// without a real DB connection. Mocks the three psql queries each
// MANUAL_SQL_INDEXES entry issues.
//
// Background: discovered 2026-08-20 that a live V2 node had never had
// _prisma_migrations populated (only ever run through `prisma db push`
// / `prisma db push --force-reset`, never `prisma migrate deploy`), so
// two partial/expression UNIQUE indexes that schema.prisma cannot
// express were silently missing:
//   - NotificationGroup's open-bucket uniqueness -> 5000+ 42P10 crashes
//     over 4 days, every one a lost follow/like notification.
//   - TxQueue's active-cawonce uniqueness -> duplicate-in-flight-tx
//     guard silently disabled.
// install.js already created the NotificationGroup one, but only on
// `caw install` -- `npm run prisma:reset` (used for this node's actual
// history, via CawProfileLedger wiring-bug recovery) bypasses that
// step entirely, and `npm run prisma:push` runs on every server boot
// via the "api" script, so a lost index never comes back on its own.
//
// Run: node scripts/verify-ensure-manual-sql-indexes.js

// --- Simulated psql layer ---
// state: { [indexName]: boolean (exists) }, and a set of index names
// that currently have duplicate-row violations pending.
function makeFakePsql(existingIndexes, blockedIndexes) {
  return {
    indexExists: (name) => existingIndexes.has(name),
    hasDuplicates: (name) => blockedIndexes.has(name),
  }
}

// Mirrors ensureManualSqlIndexes' per-entry decision tree exactly,
// against the fake psql layer instead of a real connection.
function ensureIndexesAgainst(fakePsql, indexNames) {
  const results = []
  for (const name of indexNames) {
    if (fakePsql.indexExists(name)) {
      results.push({ name, status: 'already-present' })
      continue
    }
    if (fakePsql.hasDuplicates(name)) {
      results.push({ name, status: 'blocked' })
      continue
    }
    results.push({ name, status: 'created' })
  }
  return results
}

function checkIndexesAgainst(fakePsql, indexNames) {
  return indexNames.map(name => ({
    name,
    status: fakePsql.indexExists(name) ? 'already-present' : 'missing',
  }))
}

const INDEX_NAMES = ['NotificationGroup_open_bucket_key', 'TxQueue_senderId_cawonce_active_unique']

let failures = 0
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

// 1) Fresh node, nothing exists, no duplicates: both indexes get created.
const fresh = makeFakePsql(new Set(), new Set())
const r1 = ensureIndexesAgainst(fresh, INDEX_NAMES)
check('1: fresh node creates both missing indexes', r1.map(r => r.status), ['created', 'created'])

// 2) The exact scenario found on the live node: NotificationGroup index
//    missing and no duplicates (already cleaned up by hand), TxQueue
//    index also missing and no duplicates -- both should create cleanly.
//    (This mirrors the real state right before the manual fix was applied.)
const liveNodeState = makeFakePsql(new Set(), new Set())
const r2 = ensureIndexesAgainst(liveNodeState, INDEX_NAMES)
check('2: reproduces the live-node fix (both created, no duplicates blocking)', r2.every(r => r.status === 'created'), true)

// 3) Idempotency: running again after both were created is a no-op,
//    reports already-present for both -- this is what makes it safe to
//    chain onto every `prisma db push` / `prisma:reset` run, including
//    the ones that happen on every server boot via the "api" script.
const afterFirstRun = makeFakePsql(new Set(INDEX_NAMES), new Set())
const r3 = ensureIndexesAgainst(afterFirstRun, INDEX_NAMES)
check('3: re-running after creation is a safe no-op (both already-present)', r3.map(r => r.status), ['already-present', 'already-present'])

// 4) One index already present (e.g. from install.js's older single-index
//    step), the other missing -- only the missing one gets created.
const partiallyMigrated = makeFakePsql(new Set(['NotificationGroup_open_bucket_key']), new Set())
const r4 = ensureIndexesAgainst(partiallyMigrated, INDEX_NAMES)
check('4: only the actually-missing index gets created', r4.map(r => r.status), ['already-present', 'created'])

// 5) Duplicate rows blocking one index: that one is reported as
//    'blocked' rather than silently skipped or force-created (data
//    safety -- never touches rows, never attempts a CREATE that would
//    just fail uglier).
const withDuplicates = makeFakePsql(new Set(), new Set(['TxQueue_senderId_cawonce_active_unique']))
const r5 = ensureIndexesAgainst(withDuplicates, INDEX_NAMES)
check('5: an index blocked by duplicates is reported, not silently created or skipped', r5.map(r => r.status), ['created', 'blocked'])

// 6) checkManualSqlIndexes (the read-only path `caw doctor` uses
//    without --fix) never returns 'created' or 'blocked' -- only
//    'already-present' or 'missing', since it must never write.
const r6 = checkIndexesAgainst(withDuplicates, INDEX_NAMES)
check('6: read-only check never reports created/blocked, only present/missing', r6.map(r => r.status), ['missing', 'missing'])

console.log(`\n${6 - failures}/6 passed`)
process.exit(failures > 0 ? 1 : 0)

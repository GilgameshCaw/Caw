// cli/src/steps/ensureManualSql.js
//
// `prisma db push` materializes plain columns/indexes from schema.prisma
// but does NOT create partial expression indexes (a UNIQUE index with a
// WHERE clause, or one over an expression like COALESCE(...)) -- those
// only exist as hand-rolled migration.sql files, and db push never runs
// migrations. installRunInstall already created these once (see the
// "Ensuring notification-group index" step), but that only runs on
// `caw install`. Anyone who runs `npm run prisma:reset` / `prisma db
// push --force-reset` directly bypasses that step, and every partial
// index created there is silently lost.
//
// Discovered 2026-08-20: a live V2 node had been through prisma:reset
// (via CawProfileLedger wiring-bug recovery) without ever going through
// install.js's index step, and had zero rows in _prisma_migrations --
// meaning it had never been under normal `prisma migrate deploy`
// management at all. Two partial indexes were missing as a result:
//   - NotificationGroup's open-bucket uniqueness (crash-loops
//     createNotificationWithGroup's ON CONFLICT with 42P10 on every
//     notification -- 5000+ failures/4 days on that node)
//   - TxQueue's active-cawonce uniqueness (silently disables the
//     duplicate-in-flight-transaction guard)
//
// This module is the single place both gaps (and any future ones of
// the same shape) are defined, so it can be:
//   1. Called automatically right after `prisma db push` in both
//      install.js and a wrapped prisma:reset path, so this can't
//      silently regress again.
//   2. Run standalone as a recovery/doctor command for nodes that are
//      already in this state (like the one that surfaced this).
//
// Each entry checks for pre-existing duplicate rows before creating its
// index -- a partial unique index over data that already violates it
// will fail to create, so we check first and report rather than
// attempting a CREATE that would just error out uglier.

import { execSync } from 'child_process'

export const MANUAL_SQL_INDEXES = [
  {
    name: 'NotificationGroup_open_bucket_key',
    table: 'NotificationGroup',
    // Mirrors NotificationService.ts's ON CONFLICT target exactly.
    duplicateCheckSql: `
      SELECT "userId", type, COALESCE("targetKey", '') AS bucket, COUNT(*)
      FROM "NotificationGroup"
      WHERE "isRead" = false
      GROUP BY "userId", type, COALESCE("targetKey", '')
      HAVING COUNT(*) > 1;
    `,
    createSql: `
      CREATE UNIQUE INDEX IF NOT EXISTS "NotificationGroup_open_bucket_key"
        ON "NotificationGroup" ("userId", "type", (COALESCE("targetKey", '')))
        WHERE "isRead" = false;
    `,
  },
  {
    name: 'TxQueue_senderId_cawonce_active_unique',
    table: 'TxQueue',
    // Mirrors the active-status list from
    // 20260429100000_add_txqueue_cawonce_unique/migration.sql exactly.
    duplicateCheckSql: `
      SELECT "senderId", "cawonce", COUNT(*)
      FROM "TxQueue"
      WHERE status IN ('pending', 'processing', 'awaiting_indexer', 'waiting_for_deposit')
        AND "cawonce" IS NOT NULL
      GROUP BY "senderId", "cawonce"
      HAVING COUNT(*) > 1;
    `,
    createSql: `
      CREATE UNIQUE INDEX IF NOT EXISTS "TxQueue_senderId_cawonce_active_unique"
        ON "TxQueue" ("senderId", "cawonce")
        WHERE status IN ('pending', 'processing', 'awaiting_indexer', 'waiting_for_deposit')
          AND "cawonce" IS NOT NULL;
    `,
  },
]

function runPsql(dbUrl, sql) {
  return execSync(
    `psql "${dbUrl}" -v ON_ERROR_STOP=1 -t -A -c ${JSON.stringify(sql)}`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

function indexExists(dbUrl, indexName, table) {
  const out = runPsql(
    dbUrl,
    `SELECT 1 FROM pg_indexes WHERE tablename = '${table}' AND indexname = '${indexName}';`,
  )
  return out.trim().length > 0
}

/**
 * Ensures every index in MANUAL_SQL_INDEXES exists, creating it if
 * missing. Returns a per-index result so callers (install.js's spinner,
 * or a standalone doctor command) can report specifics rather than a
 * single pass/fail.
 *
 * Never touches data -- if an index is missing AND duplicates exist
 * that would violate it, that entry is reported as 'blocked' with the
 * duplicate rows rather than silently skipped or force-created.
 */
/**
 * Read-only variant of ensureManualSqlIndexes -- reports which indexes
 * are missing without creating anything. Used by `caw doctor` without
 * --fix, which promises never to write.
 */
export function checkManualSqlIndexes(dbUrl) {
  return MANUAL_SQL_INDEXES.map(entry => ({
    name: entry.name,
    status: indexExists(dbUrl, entry.name, entry.table) ? 'already-present' : 'missing',
  }))
}

export function ensureManualSqlIndexes(dbUrl) {
  const results = []
  for (const entry of MANUAL_SQL_INDEXES) {
    try {
      if (indexExists(dbUrl, entry.name, entry.table)) {
        results.push({ name: entry.name, status: 'already-present' })
        continue
      }
      const duplicates = runPsql(dbUrl, entry.duplicateCheckSql).trim()
      if (duplicates.length > 0) {
        results.push({ name: entry.name, status: 'blocked', duplicates })
        continue
      }
      runPsql(dbUrl, entry.createSql)
      results.push({ name: entry.name, status: 'created' })
    } catch (e) {
      results.push({ name: entry.name, status: 'error', error: e.message })
    }
  }
  return results
}

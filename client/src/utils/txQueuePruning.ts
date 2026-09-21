/**
 * TxQueue retention.
 *
 * TxQueue is per-node staging state: the signed payload a validator submits on
 * chain. Once a row reaches a final status nothing polls for it any more, but
 * nothing removed it either, so the table grew with every action the node ever
 * handled (about 1.4 kB per row).
 *
 * This deletes final rows once they are older than a retention window, judged by
 * `updatedAt` (the time of the last status change):
 *
 *   - failed group: failed, cancelled, underpriced, retried. Default 90 days, so
 *     the reason an action failed stays available for troubleshooting.
 *     A failed row is kept while a pending WithdrawalRequest still points at it
 *     (same sender and cawonce), because GET /api/withdrawals uses that row to
 *     mark the withdrawal as failed. A failed row older than the window is also
 *     no longer picked up by the session-registration recovery in ChainSyncService.
 *   - done group: done, validated_by_peer. Default 180 days. A done row holds the
 *     signature returned by GET /api/caws/verify/:userId/:cawonce. After it is
 *     deleted that endpoint answers "No transaction record found", which the
 *     frontend's spot check does not count against the host (the same answer
 *     is normal for posts a peer mirror relayed).
 *
 * Only the statuses listed below are ever deleted. In-flight statuses, and any
 * status added later, are left alone.
 *
 * Safety limits:
 *   - An unusable retention setting switches that group off instead of falling
 *     back to a default, so a typo never deletes data.
 *   - One run has a batch limit and a time budget per group, so a large backlog
 *     is cleared over several runs and cannot hold up the DataCleaner loop (its
 *     watchdog is 5 minutes).
 *   - The run is skipped when the application clock and the database clock
 *     disagree by more than 10 minutes, because the cutoff comes from the
 *     application clock and a wrong clock would move it.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '../prismaClient'

export const TXQUEUE_FAILED_STATUSES = ['failed', 'cancelled', 'underpriced', 'retried'] as const
export const TXQUEUE_DONE_STATUSES = ['done', 'validated_by_peer'] as const

export const DEFAULT_FAILED_RETENTION_DAYS = 90
export const DEFAULT_DONE_RETENTION_DAYS = 180
export const MAX_RETENTION_DAYS = 36_500

export const DEFAULT_BATCH_SIZE = 5_000
export const MAX_BATCH_SIZE = 50_000
/** Batches per group in one run (5,000 rows each by default). */
export const DEFAULT_MAX_BATCHES = 200
export const MAX_MAX_BATCHES = 10_000
/** Time budget per group in one run. The cleanup loop's watchdog is 5 minutes. */
export const DEFAULT_MAX_MS = 60_000
export const MIN_MAX_MS = 1_000
export const MAX_MAX_MS = 120_000
export const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000

export interface RetentionSetting {
  /** Whole days. null means this group is not pruned (switched off, or the value was unusable). */
  days: number | null
  /** False when a value was set but is unusable. The group is then not pruned. */
  valid: boolean
}

/**
 * Parse a retention setting from the environment.
 * Unset or blank -> the default. "off" -> null (keep this group forever).
 * A whole number from 1 to MAX_RETENTION_DAYS -> that many days.
 * Anything else (0, negative, decimals, text) -> null with valid = false: the
 * group is NOT pruned until the value is fixed.
 */
export function parseRetentionDays(raw: string | undefined, fallback: number): RetentionSetting {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === '') return { days: fallback, valid: true }
  if (v === 'off') return { days: null, valid: true }
  if (/^[0-9]+$/.test(v)) {
    const n = Number(v)
    if (Number.isSafeInteger(n) && n >= 1 && n <= MAX_RETENTION_DAYS) return { days: n, valid: true }
  }
  return { days: null, valid: false }
}

export interface CleanTxQueueOptions {
  /** Days to keep the failed group, or null to leave it alone. */
  failedDays: number | null
  /** Days to keep the done group, or null to leave it alone. */
  doneDays: number | null
  batchSize?: number
  /** Most batches per group in this run. Whatever is left waits for the next run. */
  maxBatches?: number
  /** Time budget per group in this run. A batch that has started is finished. */
  maxMs?: number
  /** Current time in ms since the epoch. For tests. */
  nowMs?: number
}

export interface CleanTxQueueResult {
  failedDeleted: number
  doneDeleted: number
  /** True when a group stopped at a limit and may still have rows left. */
  capped: boolean
}

function assertInt(name: string, v: number, min: number, max: number): void {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new RangeError(`${name} must be a whole number between ${min} and ${max}`)
  }
}

function assertDays(name: string, v: number | null): void {
  if (v !== null) assertInt(name, v, 1, MAX_RETENTION_DAYS)
}

/**
 * Cutoff as ISO text, cast to `timestamp` in SQL. "updatedAt" is a timestamp
 * without time zone that holds UTC wall-clock time. A JS Date parameter would be
 * treated as timestamptz and compared through the database session TimeZone,
 * which moves the cutoff by the UTC offset on a node whose session is not UTC.
 */
function cutoffIso(days: number, nowMs: number): string {
  return new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString()
}

async function assertClockSane(nowMs: number): Promise<void> {
  const rows: any[] = await prisma.$queryRaw`
    SELECT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS db_now`
  const dbNow = Date.parse(String(rows[0]?.db_now))
  if (!Number.isFinite(dbNow)) throw new Error('could not read the database clock')
  const skewMs = Math.abs(dbNow - nowMs)
  if (skewMs > MAX_CLOCK_SKEW_MS) {
    throw new Error(`the application clock and the database clock differ by ${Math.round(skewMs / 1000)} s; nothing was deleted`)
  }
}

async function deleteInBatches(
  statuses: readonly string[],
  cutoff: string,
  batchSize: number,
  keepPendingWithdrawals: boolean,
  maxBatches: number,
  maxMs: number,
): Promise<{ deleted: number; capped: boolean }> {
  const deadline = Date.now() + maxMs
  let total = 0
  // No ORDER BY: any qualifying rows will do, and sorting every match for each
  // batch is what made large backlogs slow.
  for (let batch = 0; ; batch++) {
    if (batch >= maxBatches || Date.now() >= deadline) return { deleted: total, capped: true }
    const deleted = keepPendingWithdrawals
      ? await prisma.$executeRaw`
          DELETE FROM "TxQueue"
          WHERE "id" IN (
            SELECT t."id" FROM "TxQueue" t
            WHERE t."status" IN (${Prisma.join(statuses)})
              AND t."updatedAt" < ${cutoff}::timestamp
              AND NOT EXISTS (
                SELECT 1 FROM "WithdrawalRequest" w
                WHERE w."userId" = t."senderId"
                  AND w."cawonce" = t."cawonce"
                  AND w."status" = 'pending'
              )
            LIMIT ${batchSize}
          )
        `
      : await prisma.$executeRaw`
          DELETE FROM "TxQueue"
          WHERE "id" IN (
            SELECT t."id" FROM "TxQueue" t
            WHERE t."status" IN (${Prisma.join(statuses)})
              AND t."updatedAt" < ${cutoff}::timestamp
            LIMIT ${batchSize}
          )
        `
    total += Number(deleted)
    if (Number(deleted) < batchSize) return { deleted: total, capped: false }
  }
}

/**
 * Delete final TxQueue rows older than the given windows. Pass null for a group
 * to leave it alone. Deletes run in batches so no statement holds locks for long.
 * Arguments are validated before the database is touched.
 */
export async function cleanStaleTxQueue(opts: CleanTxQueueOptions): Promise<CleanTxQueueResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS
  const nowMs = opts.nowMs ?? Date.now()
  assertDays('failedDays', opts.failedDays)
  assertDays('doneDays', opts.doneDays)
  assertInt('batchSize', batchSize, 1, MAX_BATCH_SIZE)
  assertInt('maxBatches', maxBatches, 1, MAX_MAX_BATCHES)
  assertInt('maxMs', maxMs, MIN_MAX_MS, MAX_MAX_MS)

  if (opts.failedDays === null && opts.doneDays === null) return { failedDeleted: 0, doneDeleted: 0, capped: false }
  await assertClockSane(nowMs)

  const failed = opts.failedDays === null
    ? { deleted: 0, capped: false }
    : await deleteInBatches(TXQUEUE_FAILED_STATUSES, cutoffIso(opts.failedDays, nowMs), batchSize, true, maxBatches, maxMs)
  const done = opts.doneDays === null
    ? { deleted: 0, capped: false }
    : await deleteInBatches(TXQUEUE_DONE_STATUSES, cutoffIso(opts.doneDays, nowMs), batchSize, false, maxBatches, maxMs)

  return { failedDeleted: failed.deleted, doneDeleted: done.deleted, capped: failed.capped || done.capped }
}

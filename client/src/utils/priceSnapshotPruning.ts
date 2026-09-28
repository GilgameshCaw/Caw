import { prisma } from '../prismaClient'

/**
 * Retention for the PriceSnapshot table.
 *
 * ChainSyncService writes one row per token every 5 minutes and nothing else
 * ever removes them, so the table grows by roughly 210k rows per year (two
 * tokens). GET /api/prices/history is the only route that reads history, and
 * it serves at most 90 days.
 *
 * Policy:
 *  - Rows newer than `thinAgeDays` (default 7) are kept at full 5-minute
 *    resolution.
 *  - Older rows are thinned to the EARLIEST row of each (token, UTC hour).
 *    Every hour that has any data keeps exactly one row, no matter which
 *    minute the poll happened to land on. Keeping the earliest row also makes
 *    the operation idempotent: re-running it never changes which row survives.
 *  - Optionally, rows older than `maxAgeDays` are deleted outright. Unset by
 *    default, so hourly rows are kept indefinitely (about 2.5 MB per year).
 *
 * Deletes run in batches so no single statement holds row locks for long.
 */

export const DEFAULT_THIN_AGE_DAYS = 7
export const DEFAULT_BATCH_SIZE = 5000

const DAY_MS = 24 * 60 * 60 * 1000

export interface CleanPriceSnapshotsOptions {
  /** Rows older than this many days are thinned to one per hour per token. Must be >= 1. */
  thinAgeDays?: number
  /** If set, rows older than this many days are deleted. Must be greater than thinAgeDays. */
  maxAgeDays?: number | null
  /** Rows deleted per statement. */
  batchSize?: number
}

export interface CleanPriceSnapshotsResult {
  /** Total rows removed (thinned + hardDeleted). */
  deleted: number
  thinned: number
  hardDeleted: number
}

/**
 * Parse an optional "number of days" setting (query parameter or env var).
 * Returns null when the value is absent or empty; throws RangeError when it is
 * present but is not a positive number.
 */
export function parseDaysParam(raw: unknown, name = 'value'): number | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new RangeError(`${name} must be a positive number of days`)
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new RangeError(`${name} must be a positive number of days`)
  }
  return n
}

export async function cleanStalePriceSnapshots(
  options: CleanPriceSnapshotsOptions = {}
): Promise<CleanPriceSnapshotsResult> {
  const thinAgeDays = options.thinAgeDays ?? DEFAULT_THIN_AGE_DAYS
  const maxAgeDays = options.maxAgeDays ?? null
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE

  // thinAgeDays >= 1 keeps the shortest chart windows (1h..24h) at full resolution.
  if (!Number.isFinite(thinAgeDays) || thinAgeDays < 1) {
    throw new RangeError('thinAgeDays must be at least 1')
  }
  if (maxAgeDays !== null && (!Number.isFinite(maxAgeDays) || maxAgeDays <= thinAgeDays)) {
    throw new RangeError('maxAgeDays must be greater than thinAgeDays')
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError('batchSize must be a positive integer')
  }

  // "createdAt" is a timestamp WITHOUT time zone that holds UTC wall-clock time.
  // Pass the cutoffs as ISO text and cast to timestamp in SQL: the cast drops the
  // trailing "Z", so the comparison never depends on the session TimeZone (a Date
  // bound as timestamptz would be shifted by the session's UTC offset).
  const now = Date.now()
  const thinCutoff = new Date(now - thinAgeDays * DAY_MS).toISOString()
  const hardCutoff = maxAgeDays !== null ? new Date(now - maxAgeDays * DAY_MS).toISOString() : null

  let hardDeleted = 0
  let thinned = 0

  // 1. Hard delete (only when explicitly configured). Runs first so the
  //    thinning pass below never has to look at rows that are about to go.
  if (hardCutoff) {
    while (true) {
      const n = Number(await prisma.$executeRaw`
        DELETE FROM "PriceSnapshot"
        WHERE "id" IN (
          SELECT "id" FROM "PriceSnapshot"
          WHERE "createdAt" < ${hardCutoff}::text::timestamp
          LIMIT ${batchSize}
        )
      `)
      hardDeleted += n
      if (!(n >= batchSize)) break
    }
  }

  // 2. Thin everything older than thinCutoff to the earliest row per
  //    (token, hour). The window covers the whole thinned range, which stays
  //    small (about 17.5k rows per year for two tokens) once it has been thinned.
  while (true) {
    const n = Number(await prisma.$executeRaw`
      DELETE FROM "PriceSnapshot"
      WHERE "id" IN (
        SELECT "id" FROM (
          SELECT "id",
                 ROW_NUMBER() OVER (
                   PARTITION BY "token", date_trunc('hour', "createdAt")
                   ORDER BY "createdAt" ASC, "id" ASC
                 ) AS rn
          FROM "PriceSnapshot"
          WHERE "createdAt" < ${thinCutoff}::text::timestamp
        ) ranked
        WHERE rn > 1
        LIMIT ${batchSize}
      )
    `)
    thinned += n
    if (!(n >= batchSize)) break
  }

  return { deleted: hardDeleted + thinned, thinned, hardDeleted }
}

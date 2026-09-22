/**
 * Notification retention.
 *
 * NotificationGroup rolls up one or more Notification rows for display (the
 * bell feed). Neither table had a retention policy, so both grew with every
 * notification the node ever generated, including notifications for accounts
 * that never came back to read them.
 *
 * This deletes a group and its member Notification rows once the group is
 * older than a retention window, judged by `lastEventAt` (the time the group
 * was last bumped by a new member notification):
 *
 *   - read group (isRead = true): default 30 days. Once the user has seen it,
 *     nothing reads a read group after that beyond the retention window.
 *   - unread group (isRead = false): default 90 days. This is the group that
 *     sweeps dormant/abandoned accounts, since an unread group never flips to
 *     read on its own. The unread badge count is a live COUNT(*) query
 *     (GET .../notifications, users.ts profile route), so deleting a stale
 *     unread group lowers the badge with no separate counter to fix up.
 *
 * A group's `latestNotificationId` points at one of its own member rows, so
 * the member rows are deleted before the group to avoid leaving that pointer
 * dangling (NotificationGroup -> Notification has no ON DELETE in the schema).
 *
 * The candidate selection and both deletes run as one statement (a single
 * writable CTE), not a separate SELECT followed by DELETEs. Postgres computes
 * a materialized CTE once, from one snapshot, before any of the deletes run,
 * so a group that receives a new notification (and a fresh `lastEventAt`)
 * after this statement starts cannot be swept up in it, and there is no gap
 * between "read the candidates" and "delete them" for another transaction to
 * land a write into.
 *
 * ACTION_FAILED rows are not treated specially here: they are governed by the
 * same read/unread windows as everything else, both of which are shorter than
 * TxQueue's own failed-row retention (90 days default), so a notification
 * pointing at a TxQueue row is never the last thing to disappear.
 *
 * This does not touch the Elasticsearch notifications index. Nothing reads
 * that index today (POST /api/search/sync, admin-only, is the only thing that
 * writes to it, via a full resync) so a deleted row lingering there has no
 * observable effect; already-existing drift between Postgres and that index
 * predates this change.
 *
 * Safety limits: same shape as TxQueue retention (txQueuePruning.ts) --
 * an unusable retention setting switches that group off instead of falling
 * back to a default, each group gets its own batch and time budget per run,
 * and the run is skipped when the application clock and the database clock
 * disagree by more than 10 minutes.
 */
import { prisma } from '../prismaClient'

export const DEFAULT_READ_RETENTION_DAYS = 30
export const DEFAULT_UNREAD_RETENTION_DAYS = 90
export const MAX_RETENTION_DAYS = 36_500

export const DEFAULT_BATCH_SIZE = 5_000
export const MAX_BATCH_SIZE = 50_000
/** Batches per group in one run. */
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

export interface CleanNotificationsOptions {
  /** Days to keep read groups, or null to leave them alone. */
  readDays: number | null
  /** Days to keep unread groups, or null to leave them alone. */
  unreadDays: number | null
  batchSize?: number
  /** Most batches per group in this run. Whatever is left waits for the next run. */
  maxBatches?: number
  /** Time budget per group in this run. A batch that has started is finished. */
  maxMs?: number
  /** Current time in ms since the epoch. For tests. */
  nowMs?: number
}

export interface CleanNotificationsResult {
  readGroupsDeleted: number
  unreadGroupsDeleted: number
  notificationsDeleted: number
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
 * Cutoff as ISO text, cast to `timestamp` in SQL. "lastEventAt" is a timestamp
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

/**
 * Delete one batch's worth of stale groups (all with the given isRead value)
 * and their member Notification rows, as one statement. Repeats until a batch
 * comes back short (no more candidates) or a limit is hit.
 */
async function deleteGroupsInBatches(
  isRead: boolean,
  cutoff: string,
  batchSize: number,
  maxBatches: number,
  maxMs: number,
): Promise<{ groupsDeleted: number; notificationsDeleted: number; capped: boolean }> {
  const deadline = Date.now() + maxMs
  let groupsTotal = 0
  let notifTotal = 0
  // No ORDER BY: any qualifying rows will do, and sorting every match for each
  // batch is what made large backlogs slow (same reasoning as TxQueue).
  for (let batch = 0; ; batch++) {
    if (batch >= maxBatches || Date.now() >= deadline) return { groupsDeleted: groupsTotal, notificationsDeleted: notifTotal, capped: true }
    const rows: any[] = await prisma.$queryRaw`
      WITH candidate_groups AS (
        SELECT "id" FROM "NotificationGroup"
        WHERE "isRead" = ${isRead}
          AND "lastEventAt" < ${cutoff}::timestamp
        LIMIT ${batchSize}
      ),
      -- Captured before either DELETE runs (Postgres materializes a
      -- read-only CTE referenced by a data-modifying statement before that
      -- statement executes), so del_notif below deletes these exact row ids
      -- regardless of which DELETE the planner happens to run first. This
      -- matters because Notification.groupId -> NotificationGroup.id is
      -- ON DELETE SET NULL (see schema): if del_group ran first and this CTE
      -- searched live rows by "groupId IN (...)" instead of by id, the SET
      -- NULL would already have cleared groupId and del_notif would match
      -- nothing, leaving live Notification rows behind that no future sweep
      -- could find. Matching by id sidesteps that: the row still exists (SET
      -- NULL clears a column, not the row), so deleting by its captured id
      -- still works either way.
      candidate_notifs AS (
        SELECT n."id" FROM "Notification" n
        WHERE n."groupId" IN (SELECT "id" FROM candidate_groups)
      ),
      del_notif AS (
        DELETE FROM "Notification"
        WHERE "id" IN (SELECT "id" FROM candidate_notifs)
        RETURNING 1
      ),
      del_group AS (
        DELETE FROM "NotificationGroup"
        WHERE "id" IN (SELECT "id" FROM candidate_groups)
        RETURNING 1
      )
      SELECT
        (SELECT count(*) FROM candidate_groups)::int AS candidate_count,
        (SELECT count(*) FROM candidate_notifs)::int AS notif_deleted,
        (SELECT count(*) FROM del_group)::int AS group_deleted
    `
    const candidateCount = Number(rows[0]?.candidate_count ?? 0)
    const notifDeleted = Number(rows[0]?.notif_deleted ?? 0)
    const groupDeleted = Number(rows[0]?.group_deleted ?? 0)
    groupsTotal += groupDeleted
    notifTotal += notifDeleted
    if (candidateCount < batchSize) return { groupsDeleted: groupsTotal, notificationsDeleted: notifTotal, capped: false }
  }
}

/**
 * Delete stale NotificationGroup rows (and their member Notification rows)
 * older than the given windows. Pass null for a group to leave it alone.
 * Deletes run in batches so no statement holds locks for long. Arguments are
 * validated before the database is touched.
 */
export async function cleanStaleNotifications(opts: CleanNotificationsOptions): Promise<CleanNotificationsResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS
  const nowMs = opts.nowMs ?? Date.now()
  assertDays('readDays', opts.readDays)
  assertDays('unreadDays', opts.unreadDays)
  assertInt('batchSize', batchSize, 1, MAX_BATCH_SIZE)
  assertInt('maxBatches', maxBatches, 1, MAX_MAX_BATCHES)
  assertInt('maxMs', maxMs, MIN_MAX_MS, MAX_MAX_MS)

  if (opts.readDays === null && opts.unreadDays === null) {
    return { readGroupsDeleted: 0, unreadGroupsDeleted: 0, notificationsDeleted: 0, capped: false }
  }
  await assertClockSane(nowMs)

  const read = opts.readDays === null
    ? { groupsDeleted: 0, notificationsDeleted: 0, capped: false }
    : await deleteGroupsInBatches(true, cutoffIso(opts.readDays, nowMs), batchSize, maxBatches, maxMs)
  const unread = opts.unreadDays === null
    ? { groupsDeleted: 0, notificationsDeleted: 0, capped: false }
    : await deleteGroupsInBatches(false, cutoffIso(opts.unreadDays, nowMs), batchSize, maxBatches, maxMs)

  return {
    readGroupsDeleted: read.groupsDeleted,
    unreadGroupsDeleted: unread.groupsDeleted,
    notificationsDeleted: read.notificationsDeleted + unread.notificationsDeleted,
    capped: read.capped || unread.capped,
  }
}

/**
 * Paging through failed TxQueue rows for DataCleaner's cleanupFailedTxQueue().
 *
 * That sweep reads the oldest failed rows, a limited number per tick, and
 * nothing marks a row as handled (touching `updatedAt` would move the row's
 * retention window, see txQueuePruning.ts). With a plain "oldest N" read, a
 * node with more than N failed rows reads the same N every tick, and newer
 * failed rows never get their Caw, Follow and so on marked FAILED until the
 * oldest rows are pruned.
 *
 * This reads in (updatedAt, id) order and carries a cursor from one tick to the
 * next: a full page moves the cursor past its last row, and a page that is not
 * full means the end was reached, so the next read starts over from the oldest
 * row. A node with no more failed rows than the limit reads them all every
 * tick, as before. The cursor is kept in memory; after a restart the sweep
 * starts from the oldest row again. Every write the sweep does is guarded on
 * the row still being pending, so reading a row twice does no harm.
 */
import { prisma } from '../prismaClient'

export interface FailedTxQueueCursor {
  updatedAt: Date
  id: number
}

export interface FailedTxQueuePage<T> {
  rows: T[]
  /** Where the next read starts, or null to start again from the oldest row. */
  nextCursor: FailedTxQueueCursor | null
}

/** Failed rows last changed before `olderThan`, after `cursor`, oldest first. */
export async function readFailedTxQueuePage(opts: {
  cursor: FailedTxQueueCursor | null
  limit: number
  olderThan: Date
}): Promise<FailedTxQueuePage<any>> {
  const { cursor, limit, olderThan } = opts
  const rows = await prisma.txQueue.findMany({
    where: {
      status: 'failed',
      // The `gte` lets the (status, updatedAt) index start at the cursor. On its
      // own, the OR below is only a filter: the read would walk every older row
      // first, and a long pass would cost more with each tick.
      updatedAt: cursor ? { gte: cursor.updatedAt, lt: olderThan } : { lt: olderThan },
      ...(cursor
        ? {
            OR: [
              { updatedAt: { gt: cursor.updatedAt } },
              { updatedAt: cursor.updatedAt, id: { gt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: limit,
  })
  const last = rows[rows.length - 1]
  const nextCursor = rows.length >= limit && last ? { updatedAt: last.updatedAt, id: last.id } : null
  return { rows, nextCursor }
}

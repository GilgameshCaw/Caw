// src/api/shared/feedPage.ts
import { prisma } from '../../prismaClient'

export interface SplitFeedArgs {
  viewerId: number
  // Conditions AND-ed onto both halves (blocked authors, etc.).
  extraAnd: any[]
  take: number
  cursorId?: number
  include: any
  // Test seam: called with the chosen ids after the halves are read and before
  // the final read, so tests can change a post's status in between.
  // Test seam: called with the picked ids after the halves are merged and before the final read.
  afterPick?: (ids: number[]) => Promise<void>
}

type FeedRef = { id: number; createdAt: Date }

/**
 * Merges the two halves into one page in feed order (createdAt desc, id desc).
 * The halves are read at different moments, so a post can change status in
 * between and show up in both: keep one copy per id.
 */
export function mergeFeedRows(publicRows: FeedRef[], ownRows: FeedRef[], take: number): FeedRef[] {
  const byId = new Map<number, FeedRef>()
  for (const r of [...publicRows, ...ownRows]) if (!byId.has(r.id)) byId.set(r.id, r)
  return [...byId.values()]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id)
    .slice(0, take)
}

/**
 * Home feed for a logged-in viewer without one query of the form
 *   status = 'SUCCESS' OR (status IN ('PENDING','FAILED') AND userId = me)
 * On a large table Postgres answers that OR by scanning most of the table.
 * Each half on its own uses an index.
 *
 * Halves are read as (id, createdAt) only and merged. The page's rows are then
 * loaded once with the full include, under the same visibility rules, so a post
 * that was hidden or deleted after it was picked is not returned. If that drops
 * rows, the next batch is read from the same cursor until the page is full or
 * the feed is exhausted. The cursor is a keyset on (createdAt, id), which selects
 * the same rows as Prisma's `cursor + skip: 1`.
 */
export async function fetchSplitFeed(args: SplitFeedArgs): Promise<any[]> {
  const out: any[] = []
  let cursorId = args.cursorId
  for (let round = 0; round < 5 && out.length < args.take; round++) {
    const batch = await fetchBatch(args, cursorId, args.take - out.length)
    out.push(...batch.rows)
    if (batch.exhausted || batch.lastId === undefined) break
    cursorId = batch.lastId
  }
  return out
}

async function fetchBatch(args: SplitFeedArgs, cursorId: number | undefined, take: number) {
  const { viewerId, extraAnd, include, afterPick } = args
  const none = { rows: [] as any[], exhausted: true, lastId: undefined as number | undefined }

  const keyset: any[] = []
  if (cursorId !== undefined) {
    const c = await prisma.caw.findUnique({ where: { id: cursorId }, select: { id: true, createdAt: true } })
    if (!c) return none
    // The bound is implied by the OR below. It is there so the planner can start the index scan at the
    // cursor's time; with the OR alone it scans every newer row first.
    keyset.push({ createdAt: { lte: c.createdAt } })
    keyset.push({ OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] })
  }

  const [pub, own] = await Promise.all([
    prisma.caw.findMany({
      where: { AND: [{ status: 'SUCCESS' }, ...extraAnd, ...keyset] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, createdAt: true },
    }),
    prisma.caw.findMany({
      where: { AND: [{ status: { in: ['PENDING', 'FAILED'] } }, { userId: viewerId }, ...extraAnd, ...keyset] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, createdAt: true },
    }),
  ])

  const picked = mergeFeedRows(pub, own, take)
  if (picked.length === 0) return none
  // Both halves had fewer than `take` rows, so nothing is left after this batch.
  const exhausted = pub.length < take && own.length < take
  const lastId = picked[picked.length - 1].id

  if (afterPick) await afterPick(picked.map((r) => r.id))

  // Final read under the same visibility rules as the halves.
  const full = await prisma.caw.findMany({
    where: {
      AND: [
        { id: { in: picked.map((r) => r.id) } },
        { OR: [{ status: 'SUCCESS' }, { status: { in: ['PENDING', 'FAILED'] }, userId: viewerId }] },
        ...extraAnd,
      ],
    },
    include,
  })
  const byId = new Map<number, any>(full.map((r: any) => [r.id, r]))
  return { rows: picked.map((r) => byId.get(r.id)).filter((r) => r !== undefined), exhausted, lastId }
}

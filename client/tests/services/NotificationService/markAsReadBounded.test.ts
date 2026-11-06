/**
 * Bounded mark-all: markAsRead(userId, undefined, undefined, client,
 * { readUpToId }) must leave anything newer than the bound unread, so an
 * event that lands between the client's GET and its POST /read is not
 * marked read without being shown.
 *
 * In-memory fake client, no DB. The $executeRaw group-close step is
 * modelled by hand from its WHERE clause.
 */

import { expect } from 'chai'
import { NotificationService } from '../../../src/services/NotificationService'

type Row = { id: number; userId: number; groupId: number | null; isRead: boolean }
type Group = { id: number; userId: number; isRead: boolean; latestNotificationId: number }

function match(row: any, where: any): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === 'OR') {
      if (!(v as any[]).some(w => match(row, w))) return false
      continue
    }
    if (v && typeof v === 'object') {
      const c: any = v
      if ('in' in c && !c.in.includes(row[k])) return false
      if ('lte' in c && !(row[k] <= c.lte)) return false
      continue
    }
    if (row[k] !== v) return false
  }
  return true
}

function makeClient(rows: Row[], groups: Group[]) {
  return {
    notification: {
      findMany: async ({ where }: any) =>
        rows.filter(r => match(r, where)).map(r => ({ id: r.id, groupId: r.groupId })),
      updateMany: async ({ where, data }: any) => {
        for (const r of rows) if (match(r, where)) Object.assign(r, data)
      },
    },
    notificationGroup: {
      updateMany: async ({ where, data }: any) => {
        for (const g of groups) if (match(g, where)) Object.assign(g, data)
      },
      aggregate: async ({ where }: any) => {
        const ids = groups.filter(g => match(g, where)).map(g => g.latestNotificationId)
        return { _max: { latestNotificationId: ids.length > 0 ? Math.max(...ids) : null } }
      },
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = strings.join('?')
      const noUnreadMember = (g: Group) => !rows.some(r => r.groupId === g.id && r.userId === g.userId && !r.isRead)
      if (sql.includes('"latestNotificationId" <=')) {
        const [userId, bound] = values
        for (const g of groups) {
          if (g.userId === userId && !g.isRead && g.latestNotificationId <= bound && noUnreadMember(g)) g.isRead = true
        }
      } else {
        const [ids] = values
        for (const g of groups) if (ids.includes(g.id) && noUnreadMember(g)) g.isRead = true
      }
    },
  }
}

const unread = (rows: Row[]) => rows.filter(r => !r.isRead).map(r => r.id)
const openGroups = (groups: Group[]) => groups.filter(g => !g.isRead).map(g => g.id)

describe('NotificationService.markAsRead bounded mark-all', () => {
  it('leaves an event newer than the bound unread and its group open', async () => {
    // GET saw up to id 3. Like 5 joined group 1 before the POST arrived.
    const rows: Row[] = [
      { id: 1, userId: 1, groupId: 1, isRead: false },
      { id: 3, userId: 1, groupId: 2, isRead: false },
      { id: 5, userId: 1, groupId: 1, isRead: false },
    ]
    const groups: Group[] = [
      { id: 1, userId: 1, isRead: false, latestNotificationId: 5 },
      { id: 2, userId: 1, isRead: false, latestNotificationId: 3 },
    ]
    await NotificationService.markAsRead(1, undefined, undefined, makeClient(rows, groups), { readUpToId: 3 })
    expect(unread(rows)).to.deep.equal([5])
    expect(openGroups(groups)).to.deep.equal([1])
  })

  it('keeps a group open when its newest event is caught mid-insert', async () => {
    // Row 6 exists and the group's latest pointer already moved to it, but
    // its groupId is not written yet — NOT EXISTS alone would miss it.
    const rows: Row[] = [
      { id: 2, userId: 1, groupId: 1, isRead: false },
      { id: 6, userId: 1, groupId: null, isRead: false },
    ]
    const groups: Group[] = [{ id: 1, userId: 1, isRead: false, latestNotificationId: 6 }]
    await NotificationService.markAsRead(1, undefined, undefined, makeClient(rows, groups), { readUpToId: 4 })
    expect(unread(rows)).to.deep.equal([6])
    expect(openGroups(groups)).to.deep.equal([1])
  })

  it("does not touch another user's rows or groups", async () => {
    const rows: Row[] = [
      { id: 1, userId: 1, groupId: 1, isRead: false },
      { id: 2, userId: 2, groupId: 2, isRead: false },
    ]
    const groups: Group[] = [
      { id: 1, userId: 1, isRead: false, latestNotificationId: 1 },
      { id: 2, userId: 2, isRead: false, latestNotificationId: 2 },
    ]
    await NotificationService.markAsRead(1, undefined, undefined, makeClient(rows, groups), { readUpToId: 10 })
    expect(unread(rows)).to.deep.equal([2])
    expect(openGroups(groups)).to.deep.equal([2])
  })

  it('clears every group when an undone repost moved one latest pointer back', async () => {
    // Group 1's newest repost (id 20) was undone: its pointer went back to 5
    // but its lastEventAt stayed the newest, so it still sorts first. Like 10
    // in group 2 is older by time and newer by id than that pointer.
    const rows: Row[] = [
      { id: 5, userId: 1, groupId: 1, isRead: false },
      { id: 10, userId: 1, groupId: 2, isRead: false },
    ]
    const groups: Group[] = [
      { id: 1, userId: 1, isRead: false, latestNotificationId: 5 },
      { id: 2, userId: 1, isRead: false, latestNotificationId: 10 },
    ]
    const client = makeClient(rows, groups)
    const bound = await NotificationService.getReadUpToId(1, client)
    expect(bound).to.equal(10)
    await NotificationService.markAsRead(1, undefined, undefined, client, { readUpToId: bound! })
    expect(unread(rows)).to.deep.equal([])
    expect(openGroups(groups)).to.deep.equal([])
  })

  it('getReadUpToId ignores other users and is null with no groups', async () => {
    const groups: Group[] = [{ id: 2, userId: 2, isRead: false, latestNotificationId: 7 }]
    const client = makeClient([], groups)
    expect(await NotificationService.getReadUpToId(1, client)).to.equal(null)
    expect(await NotificationService.getReadUpToId(2, client)).to.equal(7)
  })

  it('without a bound, still marks everything read (explicit "mark all read")', async () => {
    const rows: Row[] = [
      { id: 1, userId: 1, groupId: 1, isRead: false },
      { id: 5, userId: 1, groupId: 1, isRead: false },
    ]
    const groups: Group[] = [{ id: 1, userId: 1, isRead: false, latestNotificationId: 5 }]
    await NotificationService.markAsRead(1, undefined, undefined, makeClient(rows, groups))
    expect(unread(rows)).to.deep.equal([])
    expect(openGroups(groups)).to.deep.equal([])
  })
})

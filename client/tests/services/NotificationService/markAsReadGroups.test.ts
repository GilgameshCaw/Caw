/**
 * markAsRead(ids) must close a NotificationGroup when the client sends the
 * id GET /api/notifications gives it for that row (the group's latest
 * member), even when older members of the group are still unread.
 *
 * In-memory fake client, no DB. The $executeRaw step (close a group only
 * when it has no unread member) is modelled by hand.
 */

import { expect } from 'chai'
import { NotificationService } from '../../../src/services/NotificationService'

type Row = { id: number; userId: number; groupId: number | null; isRead: boolean }
type Group = { id: number; userId: number; isRead: boolean }

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
    },
    $executeRaw: async (_s: TemplateStringsArray, ids: number[]) => {
      for (const g of groups) {
        if (ids.includes(g.id) && !rows.some(r => r.groupId === g.id && !r.isRead)) g.isRead = true
      }
    },
  }
}

const unread = (rows: Row[]) => rows.filter(r => !r.isRead).map(r => r.id)

describe('NotificationService.markAsRead with ids', () => {
  it('closes a group with several unread members when given its latest id', async () => {
    const rows: Row[] = [
      { id: 1, userId: 1, groupId: 1, isRead: false },
      { id: 2, userId: 1, groupId: 1, isRead: false },
      { id: 3, userId: 1, groupId: 1, isRead: false },
      { id: 4, userId: 1, groupId: 2, isRead: false },
    ]
    const groups: Group[] = [
      { id: 1, userId: 1, isRead: false },
      { id: 2, userId: 1, isRead: false },
    ]
    await NotificationService.markAsRead(1, [3, 4], undefined, makeClient(rows, groups))
    expect(unread(rows)).to.deep.equal([])
    expect(groups.map(g => g.isRead)).to.deep.equal([true, true])
  })

  it('keeps a group open when a newer member arrived after the page was fetched', async () => {
    const rows: Row[] = [
      { id: 1, userId: 1, groupId: 1, isRead: false },
      { id: 3, userId: 1, groupId: 1, isRead: false },
      { id: 5, userId: 1, groupId: 1, isRead: false },
    ]
    const groups: Group[] = [{ id: 1, userId: 1, isRead: false }]
    await NotificationService.markAsRead(1, [3], undefined, makeClient(rows, groups))
    expect(unread(rows)).to.deep.equal([5])
    expect(groups[0].isRead).to.equal(false)
  })

  it("does not touch another user's rows or groups", async () => {
    const rows: Row[] = [
      { id: 8, userId: 2, groupId: 9, isRead: false },
      { id: 9, userId: 2, groupId: 9, isRead: false },
    ]
    const groups: Group[] = [{ id: 9, userId: 2, isRead: false }]
    await NotificationService.markAsRead(1, [9], undefined, makeClient(rows, groups))
    expect(unread(rows)).to.deep.equal([8, 9])
    expect(groups[0].isRead).to.equal(false)
  })

  it('leaves the other members of the user’s other groups alone', async () => {
    const rows: Row[] = [
      { id: 1, userId: 1, groupId: 1, isRead: false },
      { id: 2, userId: 1, groupId: 1, isRead: false },
      { id: 6, userId: 1, groupId: 3, isRead: false },
      { id: 7, userId: 1, groupId: 3, isRead: false },
    ]
    const groups: Group[] = [
      { id: 1, userId: 1, isRead: false },
      { id: 3, userId: 1, isRead: false },
    ]
    await NotificationService.markAsRead(1, [2], undefined, makeClient(rows, groups))
    expect(unread(rows)).to.deep.equal([6, 7])
    expect(groups.map(g => g.isRead)).to.deep.equal([true, false])
  })
})

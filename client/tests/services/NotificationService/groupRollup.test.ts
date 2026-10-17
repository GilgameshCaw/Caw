/**
 * Unit tests for createNotificationWithGroup rollup semantics.
 *
 * These tests use an in-memory stub for the Prisma client so they run
 * without a real DB. They verify the grouping logic contract:
 *   - consecutive events on the same bucket join the open group
 *   - age/time gaps do NOT open a fresh group while the group is unread
 *   - marking a group read closes it; the next event opens a fresh group
 *   - ACTION_FAILED and the marketplace types get one group per row
 *   - hiding a row dismisses its whole group and closes it
 */

import { expect } from 'chai'
import { createNotificationWithGroup, hideNotificationGroups } from '../../../src/services/NotificationService'

// ---------------------------------------------------------------------------
// Minimal in-memory stub that mimics the Prisma client shape used by the
// helper. We model NotificationGroup and Notification as plain Maps.
// ---------------------------------------------------------------------------

interface GroupRow {
  id: number
  userId: number
  type: string
  targetKey: string | null
  isRead: boolean
  count: number
  lastEventAt: Date
  openedAt: Date
  latestNotificationId: number
}

interface NotifRow {
  id: number
  userId: number
  type: string
  cawId: number | null
  offerId: number | null
  groupId: number | null
  createdAt: Date
  [key: string]: any
}

function makeStubClient() {
  let nextGroupId = 1
  let nextNotifId = 1
  const groups = new Map<number, GroupRow>()
  const notifs = new Map<number, NotifRow>()
  let updateCalls = 0

  function matchesNotif(n: NotifRow, where: any): boolean {
    if (where.userId != null && n.userId !== where.userId) return false
    if (where.id?.in && !where.id.in.includes(n.id)) return false
    if (where.groupId?.in && !where.groupId.in.includes(n.groupId)) return false
    return true
  }

  // Simulates the ON CONFLICT DO UPDATE semantics:
  //   - bucket key: (userId, type, COALESCE(targetKey, ''))
  //   - conflict condition: isRead = false
  // Returns the group id.
  function upsertGroup(
    userId: number,
    type: string,
    targetKey: string | null,
    now: Date,
    latestNotifId: number,
  ): number {
    const coalesced = targetKey ?? ''
    // Find an existing open group for this bucket.
    let existing: GroupRow | undefined
    for (const g of groups.values()) {
      if (
        g.userId === userId &&
        g.type === type &&
        (g.targetKey ?? '') === coalesced &&
        g.isRead === false
      ) {
        existing = g
        break
      }
    }
    if (existing) {
      existing.count += 1
      existing.lastEventAt = now
      existing.latestNotificationId = latestNotifId
      return existing.id
    }
    const id = nextGroupId++
    groups.set(id, {
      id,
      userId,
      type,
      targetKey,
      isRead: false,
      count: 1,
      lastEventAt: now,
      openedAt: now,
      latestNotificationId: latestNotifId,
    })
    return id
  }

  const client = {
    notification: {
      async create({ data }: { data: any }): Promise<NotifRow> {
        const id = nextNotifId++
        const row: NotifRow = {
          id,
          userId: data.userId,
          type: data.type,
          cawId: data.cawId ?? null,
          offerId: data.offerId ?? null,
          groupId: null,
          createdAt: data.createdAt ?? new Date(),
          ...data,
        }
        notifs.set(id, row)
        return row
      },
      async update({ where, data }: { where: { id: number }; data: any }) {
        updateCalls++
        const row = notifs.get(where.id)
        if (!row) throw new Error(`Notification ${where.id} not found`)
        Object.assign(row, data)
        return row
      },
      // Only the where shapes hideNotificationGroups uses:
      // { id: { in }, userId } and { groupId: { in }, userId }.
      async findMany({ where }: { where: any }) {
        return Array.from(notifs.values())
          .filter(n => matchesNotif(n, where))
          .map(n => ({ id: n.id, groupId: n.groupId }))
      },
      async updateMany({ where, data }: { where: any; data: any }) {
        let count = 0
        for (const n of notifs.values()) {
          if (matchesNotif(n, where)) { Object.assign(n, data); count++ }
        }
        return { count }
      },
    },
    notificationGroup: {
      // Included so the stub satisfies the client type; but the new code
      // does NOT call findFirst or update on notificationGroup — it only
      // goes through $queryRawUnsafe. If these are called we throw to
      // catch regressions.
      async findFirst() { throw new Error('findFirst should not be called after ON CONFLICT refactor') },
      async create()    { throw new Error('notificationGroup.create should not be called after ON CONFLICT refactor') },
      async update()    { throw new Error('notificationGroup.update should not be called after ON CONFLICT refactor') },
      // Used by hideNotificationGroups only: { id: { in }, userId }.
      async updateMany({ where, data }: { where: any; data: any }) {
        let count = 0
        for (const g of groups.values()) {
          if (where.id.in.includes(g.id) && g.userId === where.userId) { Object.assign(g, data); count++ }
        }
        return { count }
      },
    },
    // Simulate $queryRawUnsafe: intercept the INSERT … ON CONFLICT and
    // execute the in-memory upsert instead. We parse the arguments by
    // position since the SQL template is fixed. The WITH … UPDATE
    // "Notification" form also writes the row's groupId, as Postgres does.
    async $queryRawUnsafe(
      sql: string,
      userId: number,
      type: string,
      targetKey: string | null,
      now: Date,
      latestNotifId: number,
    ): Promise<Array<{ id: number }>> {
      const id = upsertGroup(userId, type, targetKey, now, latestNotifId)
      if (sql.includes('UPDATE "Notification"')) {
        const row = notifs.get(latestNotifId)
        if (!row) return []
        row.groupId = id
      }
      return [{ id }]
    },
    get _updateCalls() { return updateCalls },
    // Expose internals for assertions.
    _groups: groups,
    _notifs: notifs,
  }

  return client
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createNotificationWithGroup / rollup semantics', () => {
  it('first notification opens a group with count=1', async () => {
    const client = makeStubClient()
    await createNotificationWithGroup(client as any, {
      userId: 1,
      actorId: 10,
      type: 'LIKE' as any,
      cawId: 42,
      createdAt: new Date('2026-01-01T10:00:00Z'),
    })
    expect(client._groups.size).to.equal(1)
    const [g] = client._groups.values()
    expect(g.count).to.equal(1)
    expect(g.isRead).to.equal(false)
    expect(g.targetKey).to.equal('42')
  })

  // A dismissal between the group join and the row's groupId write used to
  // close the group without this row. Both now happen in one statement.
  it('joins the group and writes the groupId back in one raw statement', async () => {
    const client = makeStubClient()
    const id = await createNotificationWithGroup(client as any, {
      userId: 1,
      actorId: 10,
      type: 'LIKE' as any,
      cawId: 42,
      createdAt: new Date('2026-01-01T10:00:00Z'),
    })
    const [g] = client._groups.values()
    expect(client._notifs.get(id)!.groupId).to.equal(g.id)
    expect(client._updateCalls).to.equal(0)
  })

  it('second notification on same bucket joins the group (count=2)', async () => {
    const client = makeStubClient()
    await createNotificationWithGroup(client as any, {
      userId: 1, actorId: 10, type: 'LIKE' as any, cawId: 42,
      createdAt: new Date('2026-01-01T10:00:00Z'),
    })
    await createNotificationWithGroup(client as any, {
      userId: 1, actorId: 11, type: 'LIKE' as any, cawId: 42,
      createdAt: new Date('2026-01-01T10:02:00Z'),
    })
    expect(client._groups.size).to.equal(1)
    const [g] = client._groups.values()
    expect(g.count).to.equal(2)
  })

  it('notification >15 min after prior still joins the group (key fix)', async () => {
    // This is the scenario that failed under the old 15-minute window:
    // an event arriving 4-8 hours later was opening a fresh group.
    const client = makeStubClient()
    await createNotificationWithGroup(client as any, {
      userId: 1, actorId: 10, type: 'LIKE' as any, cawId: 42,
      createdAt: new Date('2026-01-01T10:00:00Z'),
    })
    await createNotificationWithGroup(client as any, {
      userId: 1, actorId: 11, type: 'LIKE' as any, cawId: 42,
      createdAt: new Date('2026-01-01T11:00:00Z'),   // +1 hour
    })
    await createNotificationWithGroup(client as any, {
      userId: 1, actorId: 12, type: 'LIKE' as any, cawId: 42,
      createdAt: new Date('2026-01-01T18:00:00Z'),   // +8 hours
    })
    // All three must land in the single open group.
    expect(client._groups.size).to.equal(1)
    const [g] = client._groups.values()
    expect(g.count).to.equal(3)
  })

  it('after marking group read, next notification opens a fresh group', async () => {
    const client = makeStubClient()
    await createNotificationWithGroup(client as any, {
      userId: 1, actorId: 10, type: 'LIKE' as any, cawId: 42,
      createdAt: new Date('2026-01-01T10:00:00Z'),
    })

    // Simulate user reading the group.
    const [g] = client._groups.values()
    g.isRead = true

    await createNotificationWithGroup(client as any, {
      userId: 1, actorId: 13, type: 'LIKE' as any, cawId: 42,
      createdAt: new Date('2026-01-01T13:00:00Z'),
    })
    // A second group must have been opened.
    expect(client._groups.size).to.equal(2)
    const counts = Array.from(client._groups.values()).map(gr => gr.count)
    expect(counts).to.include(1)  // the fresh group
  })

  it('different cawIds produce separate buckets', async () => {
    const client = makeStubClient()
    await createNotificationWithGroup(client as any, {
      userId: 1, actorId: 10, type: 'LIKE' as any, cawId: 42,
      createdAt: new Date('2026-01-01T10:00:00Z'),
    })
    await createNotificationWithGroup(client as any, {
      userId: 1, actorId: 11, type: 'LIKE' as any, cawId: 99,
      createdAt: new Date('2026-01-01T10:01:00Z'),
    })
    expect(client._groups.size).to.equal(2)
  })

  it('FOLLOW notifications (null targetKey) share one bucket', async () => {
    const client = makeStubClient()
    await createNotificationWithGroup(client as any, {
      userId: 1, actorId: 20, type: 'FOLLOW' as any,
      createdAt: new Date('2026-01-01T10:00:00Z'),
    })
    await createNotificationWithGroup(client as any, {
      userId: 1, actorId: 21, type: 'FOLLOW' as any,
      createdAt: new Date('2026-01-01T12:00:00Z'),
    })
    expect(client._groups.size).to.equal(1)
    const [g] = client._groups.values()
    expect(g.targetKey).to.equal(null)
    expect(g.count).to.equal(2)
  })

  for (const type of ['ACTION_FAILED', 'OUTBID', 'AUCTION_WON', 'SALE_SOLD', 'SALE_BOUGHT']) {
    it(`${type}: each row gets its own group while unread`, async () => {
      const client = makeStubClient()
      const a = await createNotificationWithGroup(client as any, {
        userId: 1, actorId: 1, type: type as any, actionPayload: { n: 1 },
        createdAt: new Date('2026-01-01T10:00:00Z'),
      })
      const b = await createNotificationWithGroup(client as any, {
        userId: 1, actorId: 1, type: type as any, actionPayload: { n: 2 },
        createdAt: new Date('2026-01-01T10:01:00Z'),
      })
      // Both rows stay visible: the feed renders each group's latest member.
      expect(client._groups.size).to.equal(2)
      const latest = Array.from(client._groups.values()).map(g => g.latestNotificationId).sort()
      expect(latest).to.deep.equal([a, b])
      for (const g of client._groups.values()) {
        expect(g.count).to.equal(1)
        expect(g.targetKey).to.equal(`n:${g.latestNotificationId}`)
      }
    })
  }
})

describe('hideNotificationGroups', () => {
  async function followRollup(client: ReturnType<typeof makeStubClient>, actors: number[]) {
    const ids: number[] = []
    for (const actorId of actors) {
      ids.push(await createNotificationWithGroup(client as any, {
        userId: 1, actorId, type: 'FOLLOW' as any,
        createdAt: new Date('2026-01-01T10:00:00Z'),
      }))
    }
    return ids
  }

  it('hiding the latest row hides and reads every member and closes the group', async () => {
    const client = makeStubClient()
    const ids = await followRollup(client, [20, 21, 22])
    const [g] = client._groups.values()
    expect(g.latestNotificationId).to.equal(ids[2])

    const hidden = await hideNotificationGroups(client as any, 1, [ids[2]])

    expect(hidden).to.deep.equal([ids[2]])
    expect(g.isRead).to.equal(true)
    for (const id of ids) {
      expect(client._notifs.get(id)!.hidden).to.equal(true)
      expect(client._notifs.get(id)!.isRead).to.equal(true)
    }
  })

  it('the next event after a dismissal opens a fresh group', async () => {
    const client = makeStubClient()
    const ids = await followRollup(client, [20, 21])
    await hideNotificationGroups(client as any, 1, [ids[1]])

    const next = await createNotificationWithGroup(client as any, {
      userId: 1, actorId: 23, type: 'FOLLOW' as any,
      createdAt: new Date('2026-01-01T11:00:00Z'),
    })

    expect(client._groups.size).to.equal(2)
    const fresh = client._groups.get(client._notifs.get(next)!.groupId!)!
    expect(fresh.count).to.equal(1)
    expect(fresh.isRead).to.equal(false)
    expect(client._notifs.get(next)!.hidden ?? false).to.equal(false)
  })

  it("leaves other groups and other users' rows alone", async () => {
    const client = makeStubClient()
    const like = await createNotificationWithGroup(client as any, {
      userId: 1, actorId: 10, type: 'LIKE' as any, cawId: 42,
    })
    const other = await createNotificationWithGroup(client as any, {
      userId: 2, actorId: 10, type: 'LIKE' as any, cawId: 42,
    })
    const [follow] = await followRollup(client, [20])

    // Another user's id is not found and nothing changes.
    expect(await hideNotificationGroups(client as any, 1, [other])).to.deep.equal([])
    expect(client._notifs.get(other)!.hidden ?? false).to.equal(false)

    await hideNotificationGroups(client as any, 1, [follow])
    expect(client._notifs.get(like)!.hidden ?? false).to.equal(false)
    expect(client._groups.get(client._notifs.get(like)!.groupId!)!.isRead).to.equal(false)
  })

  it('a pre-group row (groupId null) is hidden on its own', async () => {
    const client = makeStubClient()
    const legacy = await client.notification.create({
      data: { userId: 1, actorId: 10, type: 'LIKE', cawId: 7 },
    })
    expect(await hideNotificationGroups(client as any, 1, [legacy.id])).to.deep.equal([legacy.id])
    expect(client._notifs.get(legacy.id)!.hidden).to.equal(true)
  })
})

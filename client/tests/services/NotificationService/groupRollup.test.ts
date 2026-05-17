/**
 * Unit tests for createNotificationWithGroup rollup semantics.
 *
 * These tests use an in-memory stub for the Prisma client so they run
 * without a real DB. They verify the grouping logic contract:
 *   - consecutive events on the same bucket join the open group
 *   - age/time gaps do NOT open a fresh group while the group is unread
 *   - marking a group read closes it; the next event opens a fresh group
 */

import { expect } from 'chai'
import { createNotificationWithGroup } from '../../../src/services/NotificationService'

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
        const row = notifs.get(where.id)
        if (!row) throw new Error(`Notification ${where.id} not found`)
        Object.assign(row, data)
        return row
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
    },
    // Simulate $queryRawUnsafe: intercept the INSERT … ON CONFLICT and
    // execute the in-memory upsert instead. We parse the arguments by
    // position since the SQL template is fixed.
    async $queryRawUnsafe(
      _sql: string,
      userId: number,
      type: string,
      targetKey: string | null,
      now: Date,
      latestNotifId: number,
    ): Promise<Array<{ id: number }>> {
      const id = upsertGroup(userId, type, targetKey, now, latestNotifId)
      return [{ id }]
    },
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
})

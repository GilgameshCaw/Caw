// Retention of stale NotificationGroup/Notification rows: which groups go,
// which stay, that children are deleted with their group, and that the
// cutoff does not depend on the database session time zone.
//
// The database tests write rows, so they only run against a throwaway database
// whose name starts with "caw_test_" (a schema-only copy: pg_dump -s). Anywhere
// else they are skipped; the parsing tests always run.
//
//   NETWORK_ID=1 CLIENT_ID=1 DATABASE_URL='postgresql://.../caw_test_notificationprune' \
//     npx mocha --import=tsx --exit tests/utils/notificationPruning.test.ts

import { expect } from 'chai'
import { prisma } from '../../src/prismaClient'
import {
  cleanStaleNotifications,
  parseRetentionDays,
  DEFAULT_READ_RETENTION_DAYS,
  DEFAULT_UNREAD_RETENTION_DAYS,
} from '../../src/utils/notificationPruning'

const dbName = (process.env.DATABASE_URL || '').split('?')[0].split('/').pop() || ''
const describeDb = dbName.startsWith('caw_test_') ? describe : describe.skip

const USER_A = 96001
const USER_B = 96002
const ACTOR = 96003
const DAY = 24 * 60 * 60 * 1000
let nextTargetKey = 1

/** ISO time `days` days ago, moved `olderByMs` further into the past (negative = newer). */
const ago = (days: number, olderByMs = 0): string => new Date(Date.now() - days * DAY - olderByMs).toISOString()

async function seedUsers(): Promise<void> {
  for (const [id, username] of [[USER_A, 'prunetest_a'], [USER_B, 'prunetest_b'], [ACTOR, 'prunetest_actor']] as const) {
    await prisma.$executeRaw`
      INSERT INTO "User" ("id", "tokenId", "username", "updatedAt") VALUES (${id}, ${id}, ${username}, NOW())
      ON CONFLICT ("id") DO NOTHING`
  }
}

/** Inserts a group with one member notification and returns both ids. */
async function insertGroup(
  isRead: boolean,
  lastEventAtIso: string,
  userId = USER_A,
): Promise<{ groupId: number; notifId: number }> {
  const targetKey = `prunetest_${nextTargetKey++}`
  const groupRows: any[] = await prisma.$queryRaw`
    INSERT INTO "NotificationGroup" ("userId", "type", "targetKey", "openedAt", "lastEventAt", "isRead", "latestNotificationId", "count")
    VALUES (${userId}, 'LIKE', ${targetKey}, ${lastEventAtIso}::timestamp, ${lastEventAtIso}::timestamp, ${isRead}, 0, 1)
    RETURNING "id"`
  const groupId = groupRows[0].id
  const notifRows: any[] = await prisma.$queryRaw`
    INSERT INTO "Notification" ("userId", "actorId", "type", "groupId", "isRead", "createdAt", "updatedAt")
    VALUES (${userId}, ${ACTOR}, 'LIKE', ${groupId}, ${isRead}, ${lastEventAtIso}::timestamp, ${lastEventAtIso}::timestamp)
    RETURNING "id"`
  const notifId = notifRows[0].id
  await prisma.$executeRaw`UPDATE "NotificationGroup" SET "latestNotificationId" = ${notifId} WHERE "id" = ${groupId}`
  return { groupId, notifId }
}

async function remainingGroupIds(): Promise<number[]> {
  const rows: any[] = await prisma.notificationGroup.findMany({
    where: { userId: { in: [USER_A, USER_B] } },
    select: { id: true },
  })
  return rows.map((r) => r.id).sort((a, b) => a - b)
}

async function remainingNotifIds(): Promise<number[]> {
  const rows: any[] = await prisma.notification.findMany({
    where: { userId: { in: [USER_A, USER_B] } },
    select: { id: true },
  })
  return rows.map((r) => r.id).sort((a, b) => a - b)
}

async function reset(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "Notification" WHERE "userId" IN (${USER_A}, ${USER_B})`
  await prisma.$executeRaw`DELETE FROM "NotificationGroup" WHERE "userId" IN (${USER_A}, ${USER_B})`
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return false
  } catch (err) {
    return err instanceof RangeError
  }
}

async function rejectsWith(fn: () => Promise<unknown>, pattern: RegExp): Promise<boolean> {
  try {
    await fn()
    return false
  } catch (err) {
    return pattern.test(String((err as Error)?.message))
  }
}

describe('parseRetentionDays (notification)', () => {
  it('uses the fallback when unset or blank', () => {
    expect(parseRetentionDays(undefined, 30)).to.deep.equal({ days: 30, valid: true })
    expect(parseRetentionDays('', 30)).to.deep.equal({ days: 30, valid: true })
    expect(parseRetentionDays('   ', 30)).to.deep.equal({ days: 30, valid: true })
  })

  it('accepts a whole number of days, with surrounding spaces', () => {
    expect(parseRetentionDays('1', 30)).to.deep.equal({ days: 1, valid: true })
    expect(parseRetentionDays(' 90 ', 30)).to.deep.equal({ days: 90, valid: true })
    expect(parseRetentionDays('36500', 30)).to.deep.equal({ days: 36500, valid: true })
  })

  it('treats "off" as disabled, in any case', () => {
    expect(parseRetentionDays('off', 30)).to.deep.equal({ days: null, valid: true })
    expect(parseRetentionDays('OFF', 30)).to.deep.equal({ days: null, valid: true })
  })

  it('switches the group off, and flags it, for anything unusable', () => {
    for (const bad of ['0', '-3', 'abc', '1.5', '1e3', '36501', '12d', 'null']) {
      expect(parseRetentionDays(bad, 30), bad).to.deep.equal({ days: null, valid: false })
    }
  })

  it('has the documented defaults', () => {
    expect(DEFAULT_READ_RETENTION_DAYS).to.equal(30)
    expect(DEFAULT_UNREAD_RETENTION_DAYS).to.equal(90)
  })
})

describeDb('cleanStaleNotifications (disposable database)', function () {
  this.timeout(30000)

  before(async () => {
    const [{ db }]: any[] = await prisma.$queryRaw`SELECT current_database() AS db`
    if (!String(db).startsWith('caw_test_')) throw new Error(`refusing to run against database "${db}"`)
    await seedUsers()
  })
  beforeEach(reset)
  after(reset)

  it('deletes read groups older than the window and keeps newer ones', async () => {
    const old = await insertGroup(true, ago(31))
    const fresh = await insertGroup(true, ago(29))
    const res = await cleanStaleNotifications({ readDays: 30, unreadDays: null })
    expect(res).to.deep.equal({ readGroupsDeleted: 1, unreadGroupsDeleted: 0, notificationsDeleted: 1, capped: false })
    expect(await remainingGroupIds()).to.deep.equal([fresh.groupId])
    expect(old.groupId).to.be.a('number')
  })

  it('deletes unread groups older than the window and leaves the read group alone when it is off', async () => {
    const oldUnread = await insertGroup(false, ago(91))
    const freshUnread = await insertGroup(false, ago(89))
    const oldRead = await insertGroup(true, ago(400))
    const res = await cleanStaleNotifications({ readDays: null, unreadDays: 90 })
    expect(res).to.deep.equal({ readGroupsDeleted: 0, unreadGroupsDeleted: 1, notificationsDeleted: 1, capped: false })
    expect(await remainingGroupIds()).to.deep.equal([freshUnread.groupId, oldRead.groupId].sort((a, b) => a - b))
    expect(oldUnread.groupId).to.be.a('number')
  })

  it("deletes a group's member notifications together with the group (no dangling groupId)", async () => {
    const stale = await insertGroup(true, ago(31))
    await cleanStaleNotifications({ readDays: 30, unreadDays: null })
    expect(await remainingGroupIds()).to.deep.equal([])
    expect(await remainingNotifIds()).to.deep.equal([])
    expect(stale.notifId).to.be.a('number')
  })

  it('is idempotent and gives the same result for any batch size', async () => {
    const build = async () => {
      for (let i = 0; i < 12; i++) await insertGroup(true, ago(45))
      for (let i = 0; i < 7; i++) await insertGroup(false, ago(200))
      for (let i = 0; i < 5; i++) await insertGroup(false, ago(10))
    }
    await build()
    const small = await cleanStaleNotifications({ readDays: 30, unreadDays: 90, batchSize: 2 })
    expect(small).to.deep.equal({ readGroupsDeleted: 12, unreadGroupsDeleted: 7, notificationsDeleted: 19, capped: false })
    expect(await remainingGroupIds()).to.have.length(5)
    expect(await cleanStaleNotifications({ readDays: 30, unreadDays: 90, batchSize: 2 })).to.deep.equal({
      readGroupsDeleted: 0, unreadGroupsDeleted: 0, notificationsDeleted: 0, capped: false,
    })

    await reset()
    await build()
    const large = await cleanStaleNotifications({ readDays: 30, unreadDays: 90, batchSize: 5000 })
    expect(large).to.deep.equal(small)
  })

  it('does not depend on the database session time zone', async () => {
    // A cutoff passed as a JS Date is shifted by the session's UTC offset when the
    // session time zone is not UTC, which would delete the newer row here.
    const older = await insertGroup(true, ago(30, 30 * 60 * 1000))
    const newer = await insertGroup(true, ago(30, -30 * 60 * 1000))
    const res = await cleanStaleNotifications({ readDays: 30, unreadDays: null })
    expect(res.readGroupsDeleted).to.equal(1)
    expect(await remainingGroupIds()).to.deep.equal([newer.groupId])
    expect(older.groupId).to.be.a('number')
  })

  it('does nothing when both groups are off', async () => {
    const g = await insertGroup(false, ago(4000))
    expect(await cleanStaleNotifications({ readDays: null, unreadDays: null })).to.deep.equal({
      readGroupsDeleted: 0, unreadGroupsDeleted: 0, notificationsDeleted: 0, capped: false,
    })
    expect(await remainingGroupIds()).to.deep.equal([g.groupId])
  })

  it('a fresh notification landing in a group during the sweep is not caught by an older batch', async () => {
    // The group starts stale; a "new" member arrives (bumping lastEventAt to
    // now) before the sweep runs. Because candidate selection and both
    // deletes happen inside one statement against one snapshot, a group whose
    // lastEventAt no longer qualifies at the time the statement runs is not a
    // candidate at all -- there is no separate "select, then delete" gap for
    // this race to land in.
    const g = await insertGroup(true, ago(60))
    await prisma.$executeRaw`UPDATE "NotificationGroup" SET "lastEventAt" = NOW() WHERE "id" = ${g.groupId}`
    const res = await cleanStaleNotifications({ readDays: 30, unreadDays: null })
    expect(res).to.deep.equal({ readGroupsDeleted: 0, unreadGroupsDeleted: 0, notificationsDeleted: 0, capped: false })
    expect(await remainingGroupIds()).to.deep.equal([g.groupId])
  })

  it('the unread badge count (a live query) reflects unread pruning with no separate counter to fix up', async () => {
    const staleUnread = await insertGroup(false, ago(91), USER_B)
    const freshUnread = await insertGroup(false, ago(10), USER_B)
    const before = await prisma.notificationGroup.count({ where: { userId: USER_B, isRead: false } })
    expect(before).to.equal(2)
    await cleanStaleNotifications({ readDays: null, unreadDays: 90 })
    const after = await prisma.notificationGroup.count({ where: { userId: USER_B, isRead: false } })
    expect(after).to.equal(1)
    expect(staleUnread.groupId).to.be.a('number')
    expect(freshUnread.groupId).to.be.a('number')
  })

  it('rejects invalid arguments before touching the database', async () => {
    const g = await insertGroup(true, ago(4000))
    for (const bad of [0, -1, 1.5, NaN, 36501]) {
      expect(await rejects(() => cleanStaleNotifications({ readDays: bad, unreadDays: null })), `readDays ${bad}`).to.equal(true)
      expect(await rejects(() => cleanStaleNotifications({ readDays: null, unreadDays: bad })), `unreadDays ${bad}`).to.equal(true)
    }
    for (const bad of [0, 1.5, 50001]) {
      expect(await rejects(() => cleanStaleNotifications({ readDays: 30, unreadDays: 90, batchSize: bad })), `batchSize ${bad}`).to.equal(true)
    }
    expect(await remainingGroupIds()).to.deep.equal([g.groupId])
  })

  it('stops at the batch limit and finishes in the next run', async () => {
    for (let i = 0; i < 12; i++) await insertGroup(true, ago(100))
    const first = await cleanStaleNotifications({ readDays: 90, unreadDays: null, batchSize: 2, maxBatches: 3 })
    expect(first).to.deep.equal({ readGroupsDeleted: 6, unreadGroupsDeleted: 0, notificationsDeleted: 6, capped: true })
    expect(await remainingGroupIds()).to.have.length(6)
    const second = await cleanStaleNotifications({ readDays: 90, unreadDays: null, batchSize: 2, maxBatches: 10 })
    expect(second).to.deep.equal({ readGroupsDeleted: 6, unreadGroupsDeleted: 0, notificationsDeleted: 6, capped: false })
    expect(await remainingGroupIds()).to.have.length(0)
  })

  it('deletes nothing when the application clock and the database clock disagree', async () => {
    const g = await insertGroup(true, ago(4000))
    const wrongClock = Date.now() + 60 * 60 * 1000
    expect(await rejectsWith(() => cleanStaleNotifications({ readDays: 30, unreadDays: 90, nowMs: wrongClock }), /clock/)).to.equal(true)
    expect(await remainingGroupIds()).to.deep.equal([g.groupId])
    // A small difference is tolerated.
    const res = await cleanStaleNotifications({ readDays: 30, unreadDays: 90, nowMs: Date.now() + 5 * 60 * 1000 })
    expect(res.readGroupsDeleted).to.equal(1)
  })

  it('rejects invalid limits before touching the database', async () => {
    const g = await insertGroup(true, ago(4000))
    for (const bad of [0, 1.5, 10001]) {
      expect(await rejects(() => cleanStaleNotifications({ readDays: 30, unreadDays: 90, maxBatches: bad })), `maxBatches ${bad}`).to.equal(true)
    }
    for (const bad of [999, 120001, NaN]) {
      expect(await rejects(() => cleanStaleNotifications({ readDays: 30, unreadDays: 90, maxMs: bad })), `maxMs ${bad}`).to.equal(true)
    }
    expect(await remainingGroupIds()).to.deep.equal([g.groupId])
  })
})

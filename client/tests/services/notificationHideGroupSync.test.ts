/**
 * Hiding a notification must keep its NotificationGroup in step.
 *
 * The feed and the bell badge are read from NotificationGroup, so hiding a
 * member row alone left the group pointing at a hidden row and still
 * counted as unread. This drives the real hideNotificationsWithGroupSync
 * (and the real createNotificationWithGroup for setup) against a throwaway
 * database.
 *
 * SKIPS unless DATABASE_URL points at a caw_test_* database. From client/:
 *
 *   DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/caw_test_hide npx prisma migrate deploy
 *   DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/caw_test_hide \
 *   npx mocha --import=tsx --exit tests/services/notificationHideGroupSync.test.ts
 */
import { describe, it, before, after, afterEach } from 'mocha'
import { expect } from 'chai'

const HAS_TEST_DB = /\/caw_test_[A-Za-z0-9_]*(\?|$)/.test(process.env.DATABASE_URL ?? '')

const BASE = 991700
const RECIPIENT = BASE
const ACTORS = [BASE + 1, BASE + 2, BASE + 3]
const ALL_USERS = [RECIPIENT, ...ACTORS]

;(HAS_TEST_DB ? describe : describe.skip)('hideNotificationsWithGroupSync keeps NotificationGroup in step', function () {
  this.timeout(60000)

  let prisma: typeof import('../../src/prismaClient').prisma
  let svc: typeof import('../../src/services/NotificationService')

  before(async () => {
    ;({ prisma } = await import('../../src/prismaClient'))
    svc = await import('../../src/services/NotificationService')
  })

  afterEach(async () => {
    await prisma.notification.deleteMany({ where: { userId: RECIPIENT } })
    await prisma.notificationGroup.deleteMany({ where: { userId: RECIPIENT } })
    await prisma.user.deleteMany({ where: { tokenId: { in: ALL_USERS } } })
  })

  after(async () => {
    await prisma.$disconnect()
  })

  async function seedUsers() {
    for (const id of ALL_USERS) {
      await prisma.user.create({ data: { id, tokenId: id, username: `u${id}` } })
    }
  }

  // FOLLOW rows all fall into one open group per recipient, like real traffic.
  async function follow(actorId: number, minute: number, client: any = prisma) {
    return svc.createNotificationWithGroup(client, {
      userId: RECIPIENT,
      actorId,
      type: 'FOLLOW',
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, minute, 0)),
    })
  }

  const groups = () => prisma.notificationGroup.findMany({ where: { userId: RECIPIENT } })
  const unreadGroups = () => prisma.notificationGroup.count({ where: { userId: RECIPIENT, isRead: false } })

  it('hiding the only member deletes the group and clears the unread count', async () => {
    await seedUsers()
    const a = await follow(ACTORS[0], 1)
    expect(await unreadGroups()).to.equal(1)

    const r = await svc.hideNotificationsWithGroupSync({ id: a, userId: RECIPIENT })

    expect(r.matched).to.equal(1)
    expect(r.hiddenIds).to.deep.equal([a])
    expect(await groups()).to.have.length(0)
    expect(await unreadGroups()).to.equal(0)
    const row = await prisma.notification.findUnique({ where: { id: a } })
    expect(row!.hidden).to.equal(true) // the hidden row itself is kept
  })

  it('hiding the latest of three re-points to the next newest and recounts', async () => {
    await seedUsers()
    const a = await follow(ACTORS[0], 1)
    const b = await follow(ACTORS[1], 2)
    const c = await follow(ACTORS[2], 3)
    expect((await groups())[0].latestNotificationId).to.equal(c)

    await svc.hideNotificationsWithGroupSync({ id: c, userId: RECIPIENT })

    const g = await groups()
    expect(g).to.have.length(1)
    expect(g[0].latestNotificationId).to.equal(b)
    expect(g[0].count).to.equal(2)
    expect(g[0].isRead).to.equal(false)
    expect(a).to.be.a('number')
  })

  it('hiding a non-latest member keeps the pointer and drops the count', async () => {
    await seedUsers()
    const a = await follow(ACTORS[0], 1)
    await follow(ACTORS[1], 2)
    const c = await follow(ACTORS[2], 3)

    await svc.hideNotificationsWithGroupSync({ id: a, userId: RECIPIENT })

    const g = await groups()
    expect(g[0].latestNotificationId).to.equal(c)
    expect(g[0].count).to.equal(2)
  })

  it('marks the group read when every remaining visible member is already read', async () => {
    await seedUsers()
    const a = await follow(ACTORS[0], 1)
    const b = await follow(ACTORS[1], 2)
    await prisma.notification.update({ where: { id: a }, data: { isRead: true } })

    await svc.hideNotificationsWithGroupSync({ id: b, userId: RECIPIENT })

    const g = await groups()
    expect(g[0].isRead).to.equal(true)
    expect(g[0].latestNotificationId).to.equal(a)
    expect(await unreadGroups()).to.equal(0)
  })

  it('re-syncs a stale group when its already-hidden member is hidden again', async () => {
    await seedUsers()
    const a = await follow(ACTORS[0], 1)
    const b = await follow(ACTORS[1], 2)
    // Legacy state: the row was hidden without touching the group.
    await prisma.notification.update({ where: { id: b }, data: { hidden: true } })
    expect((await groups())[0].latestNotificationId).to.equal(b)

    const r = await svc.hideNotificationsWithGroupSync({ id: b, userId: RECIPIENT })

    expect(r.matched).to.equal(1)
    expect(r.hiddenIds).to.deep.equal([]) // nothing newly hidden
    const g = await groups()
    expect(g[0].latestNotificationId).to.equal(a)
    expect(g[0].count).to.equal(1)
  })

  it('returns matched=0 for a notification that belongs to someone else', async () => {
    await seedUsers()
    const a = await follow(ACTORS[0], 1)

    const r = await svc.hideNotificationsWithGroupSync({ id: a, userId: ACTORS[0] })

    expect(r.matched).to.equal(0)
    expect((await prisma.notification.findUnique({ where: { id: a } }))!.hidden).to.equal(false)
    expect(await groups()).to.have.length(1)
  })

  it('bulk hide across several groups cleans each one (retry / offer-dismiss path)', async () => {
    await seedUsers()
    const f = await follow(ACTORS[0], 1)
    // Different type => its own group.
    const failed = await svc.createNotificationWithGroup(prisma as any, {
      userId: RECIPIENT,
      actorId: ACTORS[0],
      type: 'ACTION_FAILED',
      actionPayload: { originalTxQueueId: 4242 },
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, 5, 0)),
    })
    expect(await groups()).to.have.length(2)

    const r = await svc.hideNotificationsWithGroupSync({
      userId: RECIPIENT,
      type: 'ACTION_FAILED',
      hidden: false,
      actionPayload: { path: ['originalTxQueueId'], equals: 4242 } as any,
    })

    expect(r.hiddenIds).to.deep.equal([failed])
    const g = await groups()
    expect(g).to.have.length(1)
    expect(g[0].latestNotificationId).to.equal(f)
    expect(await unreadGroups()).to.equal(1)
  })

  it('a concurrent new notification is never lost to a group being deleted', async () => {
    await seedUsers()
    for (let i = 0; i < 15; i++) {
      await prisma.notification.deleteMany({ where: { userId: RECIPIENT } })
      await prisma.notificationGroup.deleteMany({ where: { userId: RECIPIENT } })

      const a = await follow(ACTORS[0], 1)
      // The indexer / ActionProcessor create notifications inside a
      // transaction, so the group upsert and the groupId back-reference
      // commit together. Mirror that here.
      const [, fresh] = await Promise.all([
        svc.hideNotificationsWithGroupSync({ id: a, userId: RECIPIENT }),
        prisma.$transaction((tx: any) => follow(ACTORS[1], 2, tx)),
      ])

      const row = await prisma.notification.findUnique({ where: { id: fresh } })
      expect(row!.groupId, `iteration ${i}: new notification lost its group`).to.not.equal(null)
      const g = await prisma.notificationGroup.findUnique({ where: { id: row!.groupId! } })
      expect(g, `iteration ${i}: group missing`).to.not.equal(null)
      expect(g!.latestNotificationId).to.equal(fresh)
      expect(g!.count).to.equal(1)
    }
  })
})

/**
 * GET /api/users/badges returns four things in one response: the unread
 * notification count, the unread marketplace-sales count, the count of
 * active offers the user has not dismissed, and the DM conversations with
 * their unread counts. This test pins what each of them counts.
 *
 * It writes rows and goes through the real HTTP route, so it needs a
 * throwaway database. It SKIPS unless DATABASE_URL points at a caw_test_*
 * database. Example (from client/):
 *
 *   DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/caw_test_badges \
 *   npx mocha --import=tsx --exit tests/api/routes/badgesCounts.test.ts
 *
 * The app is imported lazily inside `before`, after ../../helpers/isolatedEnv
 * (see followLists.test.ts). The session lookup is answered in memory by
 * replacing ioredis' `get`, so nothing is written to Redis; it is put back
 * in `after`.
 *
 * The schema has to exist in that database (the project's usual schema setup).
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import type { Server } from 'http'
import type { AddressInfo } from 'net'

const HAS_TEST_DB = /\/caw_test_[A-Za-z0-9_]*(\?|$)/.test(process.env.DATABASE_URL ?? '')

const BASE = 990300
const VIEWER = BASE          // the user whose badges are checked
const VIEWER_ALT = BASE + 1  // a second token owned by the same address
const ACTOR = BASE + 2       // ordinary other user
const BLOCKED = BASE + 3     // VIEWER blocked this user
const BLOCKER = BASE + 4     // this user blocked VIEWER
const STRANGER = BASE + 5    // owns its own token, different address
const EMPTY_A = BASE + 6     // address ''
const EMPTY_B = BASE + 7     // address '' as well
const ALL_IDS = [VIEWER, VIEWER_ALT, ACTOR, BLOCKED, BLOCKER, STRANGER, EMPTY_A, EMPTY_B]

const addr = (n: number) => '0x' + n.toString(16).padStart(40, '0')
const ADDRESS: Record<number, string> = {
  [VIEWER]: addr(VIEWER),
  [VIEWER_ALT]: addr(VIEWER),
  [ACTOR]: addr(ACTOR),
  [BLOCKED]: addr(BLOCKED),
  [BLOCKER]: addr(BLOCKER),
  [STRANGER]: addr(STRANGER),
  [EMPTY_A]: '',
  [EMPTY_B]: '',
}

const CONV_UNREAD = `badges-test-${BASE}-unread`
const CONV_READ = `badges-test-${BASE}-read`
const CONV_OTHERS = `badges-test-${BASE}-others`
const CONVERSATIONS = [CONV_UNREAD, CONV_READ, CONV_OTHERS]

// MarketplaceOffer.offerId (unique). `counted` says whether VIEWER's badge
// should include the offer.
const OFFERS = [
  { offerId: BASE * 10 + 1, tokenId: VIEWER,     status: 'ACTIVE',    dismissedBy: null,       counted: true,  name: 'active offer on the viewed token' },
  { offerId: BASE * 10 + 2, tokenId: VIEWER_ALT, status: 'ACTIVE',    dismissedBy: null,       counted: true,  name: 'active offer on another token of the same address' },
  { offerId: BASE * 10 + 3, tokenId: VIEWER,     status: 'ACTIVE',    dismissedBy: STRANGER,   counted: true,  name: 'active offer dismissed only by an unrelated user' },
  { offerId: BASE * 10 + 4, tokenId: VIEWER,     status: 'ACTIVE',    dismissedBy: VIEWER,     counted: false, name: 'offer dismissed by the viewed token' },
  { offerId: BASE * 10 + 5, tokenId: VIEWER,     status: 'ACTIVE',    dismissedBy: VIEWER_ALT, counted: false, name: 'offer dismissed by another token of the same address' },
  { offerId: BASE * 10 + 6, tokenId: VIEWER,     status: 'CANCELLED', dismissedBy: null,       counted: false, name: 'cancelled offer' },
  { offerId: BASE * 10 + 7, tokenId: VIEWER,     status: 'ACCEPTED',  dismissedBy: null,       counted: false, name: 'accepted offer' },
  { offerId: BASE * 10 + 8, tokenId: STRANGER,   status: 'ACTIVE',    dismissedBy: null,       counted: false, name: "active offer on someone else's token" },
  { offerId: BASE * 10 + 9, tokenId: EMPTY_B,    status: 'ACTIVE',    dismissedBy: null,       counted: false, name: 'active offer on a token whose address is empty' },
] as const

// Notification rows for the sales count. `counted` as above.
const SALES = [
  { userId: VIEWER,   actorId: ACTOR,   type: 'SALE_SOLD',   isRead: false, hidden: false, counted: true,  name: 'unread SALE_SOLD' },
  { userId: VIEWER,   actorId: ACTOR,   type: 'SALE_BOUGHT', isRead: false, hidden: false, counted: true,  name: 'unread SALE_BOUGHT' },
  { userId: VIEWER,   actorId: BLOCKER, type: 'SALE_SOLD',   isRead: false, hidden: false, counted: true,  name: 'unread sale from a user who blocked the viewer' },
  // Two rows from BLOCKED and one from BLOCKER, so a filter applied in the
  // wrong direction gives a different total.
  { userId: VIEWER,   actorId: BLOCKED, type: 'SALE_SOLD',   isRead: false, hidden: false, counted: false, name: 'sale from a user the viewer blocked' },
  { userId: VIEWER,   actorId: BLOCKED, type: 'SALE_BOUGHT', isRead: false, hidden: false, counted: false, name: 'purchase from a user the viewer blocked' },
  { userId: VIEWER,   actorId: ACTOR,   type: 'SALE_SOLD',   isRead: true,  hidden: false, counted: false, name: 'read sale' },
  { userId: VIEWER,   actorId: ACTOR,   type: 'SALE_SOLD',   isRead: false, hidden: true,  counted: false, name: 'hidden sale' },
  { userId: VIEWER,   actorId: ACTOR,   type: 'LIKE',        isRead: false, hidden: false, counted: false, name: 'unread notification of another type' },
  { userId: STRANGER, actorId: ACTOR,   type: 'SALE_SOLD',   isRead: false, hidden: false, counted: false, name: "another user's sale" },
] as const

// NotificationGroup rows for the bell count. One open (unread) group is
// allowed per (userId, type, targetKey), so each gets its own targetKey.
const GROUPS = [
  { userId: VIEWER,   type: 'LIKE',   targetKey: 'g1', isRead: false, counted: true },
  { userId: VIEWER,   type: 'LIKE',   targetKey: 'g2', isRead: false, counted: true },
  { userId: VIEWER,   type: 'FOLLOW', targetKey: 'g3', isRead: false, counted: true },
  { userId: VIEWER,   type: 'LIKE',   targetKey: 'g4', isRead: true,  counted: false },
  { userId: STRANGER, type: 'LIKE',   targetKey: 'g5', isRead: false, counted: false },
] as const

const count = (rows: ReadonlyArray<{ counted: boolean }>) => rows.filter(r => r.counted).length

;(HAS_TEST_DB ? describe : describe.skip)('GET /api/users/badges counts', function () {
  this.timeout(30000)

  let prisma: typeof import('../../../src/prismaClient').prisma
  let createApp: typeof import('../../../src/api/server').createApp

  let server: Server | undefined
  let baseUrl = ''
  let safe = false
  let restoreRedisGet: (() => void) | undefined
  let viewer: any
  let empty: any

  async function getBadges(tokenId: number) {
    const res = await (globalThis as any).fetch(`${baseUrl}/api/users/badges?userId=${tokenId}`, {
      headers: { 'x-session-token': `badges-test-${tokenId}` },
    })
    expect(res.status, `GET /api/users/badges?userId=${tokenId} -> ${res.status}`).to.equal(200)
    return res.json()
  }

  async function cleanup() {
    await prisma.marketplaceOffer.deleteMany({ where: { offerId: { in: OFFERS.map(o => o.offerId) } } })
    await prisma.notification.deleteMany({ where: { userId: { in: ALL_IDS } } })
    await prisma.notificationGroup.deleteMany({ where: { userId: { in: ALL_IDS } } })
    await prisma.conversation.deleteMany({ where: { id: { in: CONVERSATIONS } } })
    await prisma.dmIdentity.deleteMany({ where: { userId: { in: ALL_IDS } } })
    await prisma.block.deleteMany({ where: { OR: [{ blockerId: { in: ALL_IDS } }, { blockedId: { in: ALL_IDS } }] } })
    await prisma.user.deleteMany({ where: { tokenId: { in: ALL_IDS } } })
  }

  before(async () => {
    await import('../../helpers/isolatedEnv')
    ;({ prisma } = await import('../../../src/prismaClient'))
    ;({ createApp } = await import('../../../src/api/server'))
    const [{ current_database }] = await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`
    if (!/^caw_test_/.test(current_database)) {
      throw new Error(`refusing to run against database "${current_database}" (expected a caw_test_* database)`)
    }
    safe = true
    await cleanup()

    await prisma.user.createMany({
      data: ALL_IDS.map(id => ({ id, tokenId: id, username: `badges_test_${id}`, address: ADDRESS[id] })),
    })
    await prisma.block.createMany({
      data: [
        { blockerId: VIEWER, blockedId: BLOCKED },
        { blockerId: BLOCKER, blockedId: VIEWER },
      ],
    })

    await prisma.notification.createMany({
      data: SALES.map(({ userId, actorId, type, isRead, hidden }) => ({ userId, actorId, type, isRead, hidden })),
    })
    await prisma.notificationGroup.createMany({
      data: GROUPS.map(({ userId, type, targetKey, isRead }) => ({ userId, type, targetKey, isRead, latestNotificationId: 0 })),
    })

    for (const o of OFFERS) {
      const offer = await prisma.marketplaceOffer.create({
        data: {
          offerId: o.offerId,
          tokenId: o.tokenId,
          offerer: addr(ACTOR),
          paymentToken: 'ETH',
          paymentAddress: addr(0),
          amount: '1',
          expiry: new Date(Date.now() + 86_400_000),
          status: o.status,
          username: `badges_test_${o.tokenId}`,
        },
      })
      if (o.dismissedBy !== null) {
        await prisma.marketplaceOfferDismissal.create({ data: { offerId: offer.id, userId: o.dismissedBy } })
      }
    }

    await prisma.dmIdentity.createMany({
      data: [VIEWER, ACTOR, STRANGER].map(id => ({ userId: id, walletAddress: ADDRESS[id], publicKey: `pk-${id}` })),
    })
    await prisma.conversation.createMany({
      data: CONVERSATIONS.map(id => ({ id, creatorId: ACTOR })),
    })
    await prisma.conversationParticipant.createMany({
      data: [
        { conversationId: CONV_UNREAD, userId: VIEWER, unreadCount: 3 },
        { conversationId: CONV_UNREAD, userId: ACTOR, unreadCount: 0 },
        { conversationId: CONV_READ, userId: VIEWER, unreadCount: 0 },
        { conversationId: CONV_READ, userId: ACTOR, unreadCount: 5 },
        { conversationId: CONV_OTHERS, userId: ACTOR, unreadCount: 2 },
        { conversationId: CONV_OTHERS, userId: STRANGER, unreadCount: 4 },
      ],
    })

    // Sessions: "badges-test-<tokenId>" is a session authorized for that token.
    const Redis = (await import('ioredis')).default
    const proto = Redis.prototype as any
    const origGet = proto.get
    proto.get = async function (key: string, ...rest: unknown[]) {
      const m = /^caw:session:badges-test-(\d+)$/.exec(String(key))
      if (!m) return origGet.call(this, key, ...rest)
      const id = Number(m[1])
      return JSON.stringify({
        authorizedTokenIds: [id],
        authorizedAddresses: [ADDRESS[id]],
        createdAt: Date.now(),
        expiresAt: Date.now() + 3_600_000,
      })
    }
    restoreRedisGet = () => { proto.get = origGet }

    await new Promise<void>(resolve => {
      server = createApp().listen(0, '127.0.0.1', () => resolve())
    })
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`

    viewer = await getBadges(VIEWER)
    empty = await getBadges(EMPTY_A)
  })

  after(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    restoreRedisGet?.()
    if (safe) await cleanup()
  })

  it('notifications: counts unread notification groups of this user only', () => {
    expect(viewer.notifications).to.equal(count(GROUPS))
    expect(viewer.notifications).to.equal(3)
  })

  it('sales: counts unread, visible SALE_* notifications, except from users the viewer blocked', () => {
    expect(viewer.sales).to.equal(count(SALES))
    expect(viewer.sales).to.equal(3)
  })

  it('offers: counts active offers on every token of the address, minus the ones those tokens dismissed', () => {
    expect(viewer.offers).to.equal(count(OFFERS))
    expect(viewer.offers).to.equal(3)
  })

  it('dmConversations: lists each conversation of this user with its own unread count', () => {
    const sorted = [...viewer.dmConversations].sort((a: any, b: any) => a.id.localeCompare(b.id))
    expect(sorted).to.deep.equal([
      { id: CONV_READ, unreadCount: 0 },
      { id: CONV_UNREAD, unreadCount: 3 },
    ])
  })

  it('a user with an empty address gets zero offers, and empty results elsewhere', () => {
    expect(empty).to.deep.equal({ notifications: 0, offers: 0, sales: 0, dmConversations: [] })
  })

  it('returns exactly the four fields', () => {
    expect(Object.keys(viewer).sort()).to.deep.equal(['dmConversations', 'notifications', 'offers', 'sales'])
  })
})

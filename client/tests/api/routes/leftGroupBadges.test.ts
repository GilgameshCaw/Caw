/**
 * A member who left a group (or was removed) keeps their
 * ConversationParticipant row with leftAt set. The badge counts and the
 * DM rate limit must treat that row as "not in the conversation", the way
 * the inbox list (DmService.getConversations) and getRequestCount already
 * do:
 *
 * - GET /api/users/badges and GET /api/me (badges.dmConversations) must
 *   not list the group, or its unread count stays in the sidebar badge
 *   with no way to clear it.
 * - checkDmRate must not count the recipient's messages in that group as
 *   a prior reply (warm, 100/h instead of 10/h).
 *
 * No database: the prisma delegate methods these paths call are replaced
 * with an in-memory table, and ioredis' `get` (the session lookup) and
 * `pipeline` (the rate bucket) are replaced too. The fake query evaluator
 * throws on a filter key it doesn't know, so a query shape it can't judge
 * fails the test instead of passing it. Everything is put back after.
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import express from 'express'
import request from 'supertest'
import Redis from 'ioredis'

process.env.REDIS_URL = 'redis://127.0.0.1:1/15'
process.env.NETWORK_ID ||= '1'

const GROUP = 'conv-group'
const DM = 'conv-dm'
const LEFT = 7     // left GROUP, still in DM
const OWNER = 8
const MEMBER = 9   // still in GROUP
const NOTIFICATIONS = 3

const addr = (id: number) => '0x' + id.toString(16).padStart(40, '0')
const token = (id: number) => `tok-${id}`

const participants = [
  { conversationId: GROUP, userId: LEFT, leftAt: new Date('2026-10-02T00:00:00Z'), unreadCount: 7 },
  { conversationId: GROUP, userId: OWNER, leftAt: null, unreadCount: 0 },
  { conversationId: GROUP, userId: MEMBER, leftAt: null, unreadCount: 1 },
  { conversationId: DM, userId: LEFT, leftAt: null, unreadCount: 2 },
  { conversationId: DM, userId: OWNER, leftAt: null, unreadCount: 0 },
]
// OWNER has written only in GROUP, so nothing outside GROUP makes LEFT warm.
const messages = [{ id: 'm1', conversationId: GROUP, senderId: OWNER }]

function participantMatches(p: (typeof participants)[number], where: Record<string, any>) {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'userId') { if (p.userId !== v) return false }
    else if (k === 'leftAt' && v === null) { if (p.leftAt !== null) return false }
    else throw new Error(`fake prisma: unhandled participant filter ${k}`)
  }
  return true
}
const inConversation = (conversationId: string, some: Record<string, any>) =>
  participants.some(p => p.conversationId === conversationId && participantMatches(p, some))

const fakeModels: Record<string, Record<string, (args?: any) => any>> = {
  conversation: {
    findMany: async (a: any) => {
      const keys = Object.keys(a.where)
      if (keys.join() !== 'participants' || Object.keys(a.where.participants).join() !== 'some') {
        throw new Error(`fake prisma: unhandled conversation filter ${JSON.stringify(a.where)}`)
      }
      return [GROUP, DM]
        .filter(id => inConversation(id, a.where.participants.some))
        .map(id => ({
          id,
          participants: participants
            .filter(p => p.conversationId === id && participantMatches(p, a.select.participants.where))
            .map(p => ({ unreadCount: p.unreadCount })),
        }))
    },
  },
  message: {
    findFirst: async (a: any) => {
      const { senderId, conversation, ...rest } = a.where
      if (Object.keys(rest).length || Object.keys(conversation).join() !== 'participants') {
        throw new Error(`fake prisma: unhandled message filter ${JSON.stringify(a.where)}`)
      }
      return messages.find(m => m.senderId === senderId && inConversation(m.conversationId, conversation.participants.some)) ?? null
    },
  },
  follow: { findFirst: async () => null },
  user: {
    findUnique: async (a: any) => ({ tokenId: a.where.tokenId, address: addr(a.where.tokenId), username: `u${a.where.tokenId}` }),
    findMany: async () => [],
  },
  block: { findMany: async () => [] },
  notification: { count: async () => NOTIFICATIONS },
  notificationGroup: { count: async () => NOTIFICATIONS },
}

describe('group members who left: badges and DM rate', function () {
  this.timeout(20000)

  let app: express.Express
  let checkDmRate: typeof import('../../../src/api/dmRateLimit').checkDmRate
  const restore: Array<() => void> = []

  before(async () => {
    const proto = Redis.prototype as any
    const origGet = proto.get
    proto.get = async (key: string) => {
      const m = /^caw:session:tok-(\d+)$/.exec(key)
      if (!m) return null
      const id = Number(m[1])
      return JSON.stringify({ authorizedTokenIds: [id], authorizedAddresses: [addr(id)], createdAt: 0, expiresAt: Date.now() + 3600_000 })
    }
    restore.push(() => { proto.get = origGet })
    // exec() resolving to null is checkDmRate's "Redis unreachable" path:
    // it fails open and still reports warm.
    const origPipeline = proto.pipeline
    proto.pipeline = function () {
      const p = { incr: () => p, ttl: () => p, exec: async () => null }
      return p
    }
    restore.push(() => { proto.pipeline = origPipeline })

    const { prisma } = await import('../../../src/prismaClient') as any
    for (const [model, methods] of Object.entries(fakeModels)) {
      for (const [method, fn] of Object.entries(methods)) {
        const orig = prisma[model][method]
        prisma[model][method] = fn
        restore.push(() => { prisma[model][method] = orig })
      }
    }

    ;({ checkDmRate } = await import('../../../src/api/dmRateLimit'))
    const usersRouter = (await import('../../../src/api/routes/users')).default
    const meRouter = (await import('../../../src/api/routes/me')).default
    app = express()
    app.use('/api/users', usersRouter)
    app.use('/api/me', meRouter)
  })

  after(() => { while (restore.length) restore.pop()!() })

  const badges = async (userId: number) => {
    const res = await request(app).get(`/api/users/badges?userId=${userId}`).set('x-session-token', token(userId))
    expect(res.status).to.equal(200)
    expect(res.body.notifications).to.equal(NOTIFICATIONS)
    return res.body.dmConversations
  }

  it('GET /api/users/badges leaves out a group the user left', async () => {
    expect(await badges(LEFT)).to.deep.equal([{ id: DM, unreadCount: 2 }])
  })

  it('GET /api/users/badges still lists the group for a member', async () => {
    expect(await badges(MEMBER)).to.deep.equal([{ id: GROUP, unreadCount: 1 }])
  })

  it('GET /api/me leaves out a group the user left', async () => {
    const res = await request(app).get('/api/me').set('x-session-token', token(LEFT))
    expect(res.status).to.equal(200)
    // fetchBadges returns { notifications: 0, dmConversations: [] } when a
    // query throws; the count shows it ran to the end.
    expect(res.body.badges.notifications).to.equal(NOTIFICATIONS)
    expect(res.body.badges.dmConversations).to.deep.equal([{ id: DM, unreadCount: 2 }])
  })

  it("checkDmRate: the recipient's messages in a group the sender left don't make the pair warm", async () => {
    expect((await checkDmRate(LEFT, OWNER)).warm).to.equal(false)
  })

  it("checkDmRate: they still do for a member of that group", async () => {
    expect((await checkDmRate(MEMBER, OWNER)).warm).to.equal(true)
  })
})

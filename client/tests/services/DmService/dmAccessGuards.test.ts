// Access checks on the DM routes and the websocket that a removed member, or
// someone who was never in the conversation, got past:
//   - PATCH /messages/:id: a sender who left or was removed could still replace
//     the per-recipient ciphertexts of their old message for the remaining
//     members (within the edit window)
//   - POST /messages/read: read receipts were written for conversations the
//     caller is not an active member of
//   - 'typing': relayed with socket.to(room), which does not require the sender
//     to be in the room or in the conversation, so any signed-in user could send
//     typing events into any conversation whose id they knew (1:1 ids are
//     derived from the two user ids)
//
// Runs the real routers (dm.ts, dm-groups.ts) and the real DmWebSocketService
// against a real database. Needs DATABASE_URL pointing at a disposable database
// whose name contains "caw_test_"; it skips otherwise. As in the other tests
// that load the API, ../../helpers/isolatedEnv (imported in before(), ahead of
// the app code) points Elasticsearch nowhere and the session store at Redis
// db 15. The test writes its own sessions there and removes exactly those keys.

process.env.CLIENT_ID = '1'

import { expect } from 'chai'
import Redis from 'ioredis'
import { randomBytes } from 'crypto'
import http from 'http'
import express from 'express'
import request from 'supertest'
import { io as ioClient, Socket } from 'socket.io-client'
import { PrismaClient } from '@prisma/client'

const HAS_TEST_DB = /\/caw_test_[A-Za-z0-9_]*(\?|$)/.test(process.env.DATABASE_URL ?? '')

const prisma = new PrismaClient()

const OWNER = 93001
const MEMBER = 93002   // the one removed
const STAYER = 93003
const OUTSIDER = 93004
const USERS = [OWNER, MEMBER, STAYER, OUTSIDER]
const addr = (id: number) => `0x${String(id).padStart(40, '0')}`
const sessionTokens: Record<number, string> = {}
const tokenOf = (id: number) => sessionTokens[id]
let cookieName = ''

let dmWebSocketService: typeof import('../../../src/services/DmService/websocket').default
let server: http.Server
let app: express.Express
let port: number
const sockets: Socket[] = []

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const as = (id: number) => ({ Cookie: `${cookieName}=${tokenOf(id)}` })

async function makeGroup(members: number[] = [OWNER, MEMBER, STAYER]) {
  const conv = await prisma.conversation.create({
    data: {
      type: 'GROUP', creatorId: OWNER, name: 'g',
      participants: { create: members.map(userId => ({ userId, role: userId === OWNER ? 'OWNER' : 'MEMBER' })) },
    } as any,
  })
  return conv.id
}

async function makeDm() {
  const conv = await prisma.conversation.create({
    data: {
      type: 'DM', creatorId: OWNER,
      participants: { create: [OWNER, MEMBER].map(userId => ({ userId })) },
    } as any,
  })
  return conv.id
}

// A group message as the group service stores it: ciphertext per recipient.
async function makeGroupMessage(conversationId: string, senderId: number, recipients: number[]) {
  const m = await prisma.message.create({ data: { conversationId, senderId, encryptedPayload: null } })
  await prisma.messageRecipientPayload.createMany({
    data: recipients.map(r => ({ messageId: m.id, recipientUserId: r, encryptedPayload: `ct-${r}` })),
  })
  return m
}

const payloadsFor = (ids: number[]) => Object.fromEntries(ids.map(i => [i, `new-${i}`]))

async function removeMember(conversationId: string, target: number) {
  const res = await request(app).delete(`/api/dm/groups/${conversationId}/members/${target}`)
    .set(as(OWNER)).send({ actorUserId: OWNER })
  expect(res.status, JSON.stringify(res.body)).to.equal(200)
}

async function leaveGroup(conversationId: string, userId: number) {
  const res = await request(app).post(`/api/dm/groups/${conversationId}/leave`)
    .set(as(userId)).send({ userId })
  expect(res.status, JSON.stringify(res.body)).to.equal(200)
}

type Client = { socket: Socket; events: { event: string; data: any }[] }

async function connect(userId: number): Promise<Client> {
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    path: '/dm-ws/', transports: ['websocket'], forceNew: true,
    auth: { userId, sessionToken: tokenOf(userId) },
  })
  sockets.push(socket)
  const events: Client['events'] = []
  socket.onAny((event, data) => events.push({ event, data }))
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve())
    socket.on('connect_error', reject)
  })
  // joinUserConversations runs without being awaited on connect.
  await sleep(150)
  return { socket, events }
}

const names = (c: Client) => c.events.map(e => e.event)

// A message sent through the real route; what members see arrives as 'new-message'.
async function sendGroupMessage(conversationId: string, senderId: number, recipients: number[]) {
  const res = await request(app).post('/api/dm/messages').set(as(senderId)).send({
    conversationId, senderId, recipientPayloads: payloadsFor(recipients), contentType: 'text',
  })
  expect(res.status, JSON.stringify(res.body)).to.equal(200)
  return res.body
}

let started = false
const sessionRedis = new Redis('redis://127.0.0.1:6379/15', { lazyConnect: true, maxRetriesPerRequest: 1 })

;(HAS_TEST_DB ? describe : describe.skip)('Group DM: a member who left or was removed loses access', function () {
  this.timeout(20000)

  before(async function () {
    await import('../../helpers/isolatedEnv')
    cookieName = (await import('../../../src/api/middleware/auth')).SESSION_COOKIE_NAME

    // Sessions the way the session store keeps them (caw:session:<token>).
    for (const id of USERS) {
      sessionTokens[id] = randomBytes(32).toString('hex')
      await sessionRedis.setex(`caw:session:${sessionTokens[id]}`, 3600, JSON.stringify({
        authorizedTokenIds: [id], authorizedAddresses: [addr(id)],
        createdAt: Date.now(), expiresAt: Date.now() + 3600_000,
      }))
    }

    // The session store connects to Redis when it is first imported. If another
    // test file in the same run already imported it (against another Redis),
    // these sessions are not visible to it: skip rather than fail, and run this
    // file on its own.
    const { getSession } = await import('../../../src/api/sessionStore')
    if (!(await getSession(tokenOf(OWNER)))) {
      for (const id of USERS) await sessionRedis.del(`caw:session:${sessionTokens[id]}`)
      sessionRedis.disconnect()
      return this.skip()
    }

    await cleanup()
    for (const id of USERS) {
      await prisma.user.create({ data: { id, tokenId: id, username: `dmleft${id}`, address: addr(id) } as any })
      await prisma.dmIdentity.create({ data: { userId: id, walletAddress: addr(id), publicKey: `pk-${id}` } })
    }

    dmWebSocketService = (await import('../../../src/services/DmService/websocket')).default
    const dmRouter = (await import('../../../src/api/routes/dm')).default
    const dmGroupsRouter = (await import('../../../src/api/routes/dm-groups')).default

    app = express()
    app.use(express.json())
    app.use('/api/dm', dmRouter)
    app.use('/api/dm', dmGroupsRouter)
    server = http.createServer(app)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as any).port
    dmWebSocketService.initialize(server)
    started = true
  })

  afterEach(() => {
    while (sockets.length) sockets.pop()!.disconnect()
  })

  after(async () => {
    if (!started) return   // skipped in before(); nothing was set up
    while (sockets.length) sockets.pop()!.disconnect()
    await cleanup()
    await new Promise<void>(r => server.close(() => r()))
    await prisma.$disconnect()
    for (const id of USERS) if (sessionTokens[id]) await sessionRedis.del(`caw:session:${sessionTokens[id]}`)
    sessionRedis.disconnect()
  })

  async function cleanup() {
    await prisma.conversation.deleteMany({ where: { creatorId: { in: USERS } } })
    await prisma.dmIdentity.deleteMany({ where: { userId: { in: USERS } } })
    await prisma.user.deleteMany({ where: { id: { in: USERS } } })
  }

  describe('HTTP routes', () => {
    it('edit: a removed sender cannot rewrite their message for the remaining members', async () => {
      const convId = await makeGroup()
      const msg = await makeGroupMessage(convId, MEMBER, [OWNER, MEMBER, STAYER])

      const ok = await request(app).patch(`/api/dm/messages/${msg.id}`).set(as(MEMBER))
        .send({ recipientPayloads: payloadsFor([OWNER, MEMBER, STAYER]) })
      expect(ok.status, JSON.stringify(ok.body)).to.equal(200)

      await removeMember(convId, MEMBER)
      const res = await request(app).patch(`/api/dm/messages/${msg.id}`).set(as(MEMBER))
        .send({ recipientPayloads: payloadsFor([OWNER, STAYER]) })
      expect(res.status).to.be.greaterThanOrEqual(400)

      const stored = await prisma.messageRecipientPayload.findMany({ where: { messageId: msg.id }, orderBy: { recipientUserId: 'asc' } })
      expect(stored.map(p => [p.recipientUserId, p.encryptedPayload])).to.deep.equal([
        [OWNER, `new-${OWNER}`], [MEMBER, `new-${MEMBER}`], [STAYER, `new-${STAYER}`],
      ])
    })

    it('read receipts: written for a member, not for a removed member or a non-member', async () => {
      const convId = await makeGroup()
      const msg = await makeGroupMessage(convId, OWNER, [OWNER, MEMBER, STAYER])
      await prisma.conversationParticipant.updateMany({ where: { conversationId: convId, userId: { in: [MEMBER, STAYER] } }, data: { unreadCount: 3 } })

      const ok = await request(app).post('/api/dm/messages/read').set(as(STAYER)).send({ userId: STAYER, messageIds: [msg.id] })
      expect(ok.status).to.equal(200)
      expect(ok.body.conversationIds).to.deep.equal([convId])

      await removeMember(convId, MEMBER)
      const removed = await request(app).post('/api/dm/messages/read').set(as(MEMBER)).send({ userId: MEMBER, messageIds: [msg.id] })
      expect(removed.status).to.equal(200)
      expect(removed.body.conversationIds).to.deep.equal([])
      const outsider = await request(app).post('/api/dm/messages/read').set(as(OUTSIDER)).send({ userId: OUTSIDER, messageIds: [msg.id] })
      expect(outsider.status).to.equal(200)

      const receipts = await prisma.messageReceipt.findMany({ where: { messageId: msg.id } })
      expect(receipts.map(r => r.userId)).to.deep.equal([STAYER])
      const participant = await prisma.conversationParticipant.findFirst({ where: { conversationId: convId, userId: STAYER } })
      expect(participant!.unreadCount).to.equal(0)
    })

    it('1:1 DMs are unchanged: read, react, mark read', async () => {
      const convId = await makeDm()
      const msg = await prisma.message.create({ data: { conversationId: convId, senderId: OWNER, encryptedPayload: 'ct' } })

      const get = await request(app).get(`/api/dm/conversations/${convId}/messages`).query({ userId: MEMBER }).set(as(MEMBER))
      expect(get.status).to.equal(200)
      expect(get.body.messages.map((m: any) => m.id)).to.deep.equal([msg.id])

      const react = await request(app).post(`/api/dm/messages/${msg.id}/reactions`).set(as(MEMBER)).send({ userId: MEMBER, emoji: '👍' })
      expect(react.status).to.equal(200)

      const read = await request(app).post('/api/dm/messages/read').set(as(MEMBER)).send({ userId: MEMBER, messageIds: [msg.id] })
      expect(read.status).to.equal(200)
      expect(read.body.conversationIds).to.deep.equal([convId])
      expect((await prisma.messageReceipt.findMany({ where: { messageId: msg.id } })).map(r => r.userId)).to.deep.equal([MEMBER])
    })
  })

  describe('websocket typing', () => {
    it('typing: relayed from a member, dropped from a non-member and from a removed member', async () => {
      const convId = await makeGroup()
      const stayer = await connect(STAYER)
      const member = await connect(MEMBER)
      const outsider = await connect(OUTSIDER)

      member.socket.emit('typing', { conversationId: convId, isTyping: true })
      await sleep(200)
      expect(stayer.events.filter(e => e.event === 'user-typing').map(e => e.data.userId), 'member typing').to.deep.equal([MEMBER])

      stayer.events.length = 0
      outsider.socket.emit('typing', { conversationId: convId, isTyping: true })
      await sleep(200)
      expect(stayer.events, 'non-member typing').to.deep.equal([])

      await removeMember(convId, MEMBER)
      await sleep(100)
      stayer.events.length = 0
      member.socket.emit('typing', { conversationId: convId, isTyping: true })
      await sleep(200)
      expect(stayer.events, 'removed member typing').to.deep.equal([])
    })

    it('typing: a member who switched away from the conversation can still send "stopped typing"', async () => {
      // The client leaves a conversation's room when it switches to another one,
      // and its 2 second "stopped typing" timer fires after that.
      const convId = await makeGroup()
      const stayer = await connect(STAYER)
      const member = await connect(MEMBER)
      member.socket.emit('typing', { conversationId: convId, isTyping: true })
      await sleep(150)
      member.socket.emit('leave-conversation', convId)
      await sleep(100)
      stayer.events.length = 0
      member.socket.emit('typing', { conversationId: convId, isTyping: false })
      await sleep(200)
      expect(stayer.events.map(e => [e.event, e.data.userId, e.data.isTyping])).to.deep.equal([['user-typing', MEMBER, false]])
    })

    it('typing in a 1:1 DM between two other users cannot be forged by an outsider', async () => {
      const convId = await makeDm()
      const peer = await connect(MEMBER)
      const outsider = await connect(OUTSIDER)
      outsider.socket.emit('typing', { conversationId: convId, isTyping: true })
      await sleep(200)
      expect(peer.events).to.deep.equal([])
    })
  })
})

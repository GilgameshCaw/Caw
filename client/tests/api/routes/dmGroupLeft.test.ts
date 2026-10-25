/**
 * The DM and group routes and the DM socket, end to end, for a member who
 * left a group (or was removed): no reactions, no hide, no live events from
 * its room, and no copy of the conversation when someone joins by invite.
 *
 * Real express + dm / dm-groups routers + DmWebSocketService on a random
 * 127.0.0.1 port, driven by supertest and socket.io-client. No database and
 * no Redis: the prisma delegate methods are replaced with an in-memory
 * table, and ioredis' `get` (the only Redis call the session lookup makes)
 * returns fixed sessions. Both are put back after the suite.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import http from 'http'
import type { AddressInfo } from 'net'
import express from 'express'
import request from 'supertest'
import Redis from 'ioredis'
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client'

process.env.REDIS_URL = 'redis://127.0.0.1:1/15'
process.env.NETWORK_ID ||= '1'

const GROUP = 'conv-group'
const DM = 'conv-dm'
const LEFT = 7     // left GROUP before the test
const OWNER = 8
const MEMBER = 9   // active; removed in one test
const JOINER = 11  // redeems an invite
const MSG = 'msg-1'

const addr = (id: number) => '0x' + id.toString(16).padStart(40, '0')
const token = (id: number) => `tok-${id}`

type Row = { id: number; conversationId: string; userId: number; role: string; leftAt: Date | null; status: string; joinedAt: Date }
let rows: Row[] = []
function resetRows() {
  const t = new Date('2026-10-01T00:00:00Z')
  rows = [
    { id: 1, conversationId: GROUP, userId: LEFT, role: 'MEMBER', leftAt: new Date('2026-10-02T00:00:00Z'), status: 'ACCEPTED', joinedAt: t },
    { id: 2, conversationId: GROUP, userId: OWNER, role: 'OWNER', leftAt: null, status: 'ACCEPTED', joinedAt: t },
    { id: 3, conversationId: GROUP, userId: MEMBER, role: 'MEMBER', leftAt: null, status: 'ACCEPTED', joinedAt: t },
    { id: 4, conversationId: DM, userId: LEFT, role: 'MEMBER', leftAt: null, status: 'ACCEPTED', joinedAt: t },
    { id: 5, conversationId: DM, userId: OWNER, role: 'MEMBER', leftAt: null, status: 'ACCEPTED', joinedAt: t },
  ]
}

function matches(r: Row, where: any = {}): boolean {
  if (where.conversationId !== undefined) {
    const c = where.conversationId
    if (typeof c === 'string' ? r.conversationId !== c : !c.in.includes(r.conversationId)) return false
  }
  if (where.userId !== undefined) {
    const u = where.userId
    if (typeof u === 'number' ? r.userId !== u : u.not !== undefined ? r.userId === u.not : !u.in.includes(r.userId)) return false
  }
  if ('leftAt' in where && where.leftAt === null && r.leftAt !== null) return false
  return true
}
const byKey = (args: any) => {
  const k = args.where.conversationId_userId
  return rows.find(r => r.conversationId === k.conversationId && r.userId === k.userId) ?? null
}
const conversation = (id: string) => ({
  id,
  type: id === GROUP ? 'GROUP' : 'DM',
  participants: rows.filter(r => r.conversationId === id).map(r => ({ ...r, identity: { publicKey: 'pk', user: { username: `u${r.userId}` } } })),
})

// Holds the next participant read for one user: the result is taken from the
// table when the read starts, and handed back only on release(), the way a
// slow query returns a snapshot from before a concurrent write.
let gate: { userId: number; captured: () => void; wait: Promise<void> } | null = null
function holdNextRead(userId: number) {
  let captured!: () => void
  let release!: () => void
  const started = new Promise<void>(r => { captured = r })
  gate = { userId, captured, wait: new Promise<void>(r => { release = r }) }
  return { started, release }
}
async function held<T>(userId: number | undefined, result: T): Promise<T> {
  if (!gate || gate.userId !== userId) return result
  const g = gate
  gate = null
  g.captured()
  await g.wait
  return result
}
const snapshot = <T>(v: T): T => (v ? JSON.parse(JSON.stringify(v)) : v)

const reactionsCreated: any[] = []
const deletionsUpserted: any[] = []
const receiptsCreated: any[] = []

// One table for both the prisma client and the transaction client.
const fakeModels: Record<string, Record<string, (args?: any) => any>> = {
  user: {
    findUnique: async (a: any) => ({ tokenId: a.where.tokenId, address: addr(a.where.tokenId), username: `u${a.where.tokenId}` }),
  },
  conversationParticipant: {
    findUnique: async (a: any) => held(a.where.conversationId_userId?.userId, snapshot(byKey(a))),
    findMany: async (a: any) => held(a.where?.userId, snapshot(rows.filter(r => matches(r, a.where)))),
    update: async (a: any) => { const r = rows.find(x => x.id === a.where.id)!; Object.assign(r, a.data); return r },
    create: async (a: any) => { const r = { id: rows.length + 1, leftAt: null, joinedAt: new Date(), ...a.data }; rows.push(r); return r },
    count: async (a: any) => rows.filter(r => matches(r, a.where)).length,
  },
  conversation: {
    findUnique: async (a: any) => conversation(a.where.id),
    update: async () => ({}),
  },
  message: {
    findUnique: async (a: any) => a.where.id === MSG ? { id: MSG, conversationId: GROUP, senderId: OWNER, conversation: conversation(GROUP) } : null,
    create: async () => ({ id: 'sys-' + Math.random(), createdAt: new Date() }),
    // mark-read looks messages up by id; the message list (getMessages) is empty.
    findMany: async (a: any) => a.where?.id?.in ? [{ id: MSG, conversationId: GROUP, senderId: OWNER }].filter(m => a.where.id.in.includes(m.id)) : [],
  },
  messageReceipt: {
    createMany: async (a: any) => { receiptsCreated.push(...a.data); return { count: a.data.length } },
  },
  messageReaction: {
    findFirst: async () => null,
    create: async (a: any) => { reactionsCreated.push(a.data); return a.data },
  },
  messageDeletion: {
    upsert: async (a: any) => { deletionsUpserted.push(a.create); return a.create },
  },
  groupInvite: {
    findUnique: async () => ({ id: 'inv-1', conversationId: GROUP, revokedAt: null, expiresAt: new Date(Date.now() + 3600_000), useCount: 0, maxUses: 5 }),
    update: async () => ({}),
  },
  dmIdentity: {
    findUnique: async (a: any) => ({ userId: a.where.userId, publicKey: 'pk' }),
  },
  block: {
    findMany: async () => [],
  },
}

describe('DM routes and socket for a group member who left', function () {
  this.timeout(20000)

  let prisma: any
  let dmWebSocketService: typeof import('../../../src/services/DmService/websocket').default
  let server: http.Server
  let base = ''
  const restore: Array<() => void> = []
  let clients: ClientSocket[] = []

  function connect(userId: number): Promise<ClientSocket & { got: Array<[string, any]> }> {
    return new Promise((resolve, reject) => {
      const s = ioClient(base, { path: '/dm-ws/', transports: ['websocket'], auth: { sessionToken: token(userId), userId }, reconnection: false }) as any
      s.got = []
      s.onAny((event: string, data: any) => s.got.push([event, data]))
      s.on('connect', () => resolve(s))
      s.on('connect_error', reject)
      clients.push(s)
    })
  }
  const settle = (ms = 150) => new Promise(r => setTimeout(r, ms))
  const events = (s: any, name: string, conversationId: string) =>
    s.got.filter(([e, d]: [string, any]) => e === name && d?.conversationId === conversationId)

  before(async () => {
    const origGet = (Redis.prototype as any).get
    ;(Redis.prototype as any).get = async (key: string) => {
      const m = /^caw:session:tok-(\d+)$/.exec(key)
      if (!m) return null
      const id = Number(m[1])
      return JSON.stringify({ authorizedTokenIds: [id], authorizedAddresses: [addr(id)], createdAt: 0, expiresAt: Date.now() + 3600_000 })
    }
    restore.push(() => { (Redis.prototype as any).get = origGet })

    ;({ prisma } = await import('../../../src/prismaClient'))
    for (const [model, methods] of Object.entries(fakeModels)) {
      for (const [method, fn] of Object.entries(methods)) {
        const orig = prisma[model][method]
        prisma[model][method] = fn
        restore.push(() => { prisma[model][method] = orig })
      }
    }
    const origTx = prisma.$transaction
    ;(prisma as any).$transaction = async (fn: any) => fn(fakeModels)
    restore.push(() => { (prisma as any).$transaction = origTx })

    dmWebSocketService = (await import('../../../src/services/DmService/websocket')).default
    const dmRouter = (await import('../../../src/api/routes/dm')).default
    const dmGroupsRouter = (await import('../../../src/api/routes/dm-groups')).default
    const app = express()
    app.use(express.json())
    app.use('/api/dm', dmGroupsRouter)
    app.use('/api/dm', dmRouter)
    server = http.createServer(app)
    dmWebSocketService.initialize(server)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    await new Promise(r => server.close(() => r(undefined)))
    while (restore.length) restore.pop()!()
  })

  beforeEach(() => {
    resetRows()
    gate = null
    reactionsCreated.length = 0
    deletionsUpserted.length = 0
    receiptsCreated.length = 0
  })

  afterEach(() => {
    for (const c of clients) c.disconnect()
    clients = []
  })

  it('a member who left gets no live events from the group on connect; 1:1 and active members still do', async () => {
    const left = await connect(LEFT)
    const member = await connect(MEMBER)
    await settle()
    left.emit('join-conversation', GROUP)
    await settle()
    dmWebSocketService.broadcastMessage({ id: 'g1', conversationId: GROUP, senderId: OWNER })
    dmWebSocketService.broadcastMessage({ id: 'd1', conversationId: DM, senderId: OWNER })
    await settle()
    expect(events(member, 'new-message', GROUP)).to.have.length(1)
    expect(events(left, 'new-message', DM)).to.have.length(1)
    expect(events(left, 'new-message', GROUP)).to.have.length(0)
  })

  it('a removed member stops getting the group\'s events at once, after the member-removed event', async () => {
    const member = await connect(MEMBER)
    const owner = await connect(OWNER)
    await settle()
    const res = await request(base).delete(`/api/dm/groups/${GROUP}/members/${MEMBER}`)
      .set('x-session-token', token(OWNER)).send({ actorUserId: OWNER })
    expect(res.status).to.equal(200)
    await settle()
    expect(events(member, 'conversation-update', GROUP).map(([, d]: any) => d.kind)).to.deep.equal(['member-removed'])
    dmWebSocketService.broadcastMessage({ id: 'g2', conversationId: GROUP, senderId: OWNER })
    await settle()
    expect(events(owner, 'conversation-update', GROUP)).to.have.length(1)
    expect(events(member, 'new-message', GROUP)).to.have.length(0)
  })

  it('a member who leaves stops getting the group\'s events', async () => {
    const member = await connect(MEMBER)
    await settle()
    const res = await request(base).post(`/api/dm/groups/${GROUP}/leave`)
      .set('x-session-token', token(MEMBER)).send({ userId: MEMBER })
    expect(res.status).to.equal(200)
    await settle()
    dmWebSocketService.broadcastMessage({ id: 'g3', conversationId: GROUP, senderId: OWNER })
    await settle()
    expect(events(member, 'new-message', GROUP)).to.have.length(0)
  })

  it('a member who left cannot react; an active member can', async () => {
    const res = await request(base).post(`/api/dm/messages/${MSG}/reactions`)
      .set('x-session-token', token(LEFT)).send({ userId: LEFT, emoji: '👍' })
    expect(res.status).to.equal(400)
    expect(res.body.error).to.equal('MISSING_TOKEN_ID')
    const ok = await request(base).post(`/api/dm/messages/${MSG}/reactions`)
      .set('x-session-token', token(MEMBER)).send({ userId: MEMBER, emoji: '👍' })
    expect(ok.status).to.equal(200)
    expect(reactionsCreated.map(r => r.userId)).to.deep.equal([MEMBER])
  })

  it('a member who left cannot hide a group message; an active member can', async () => {
    const res = await request(base).post(`/api/dm/messages/${MSG}/hide`)
      .set('x-session-token', token(LEFT)).send({ userId: LEFT })
    expect(res.status).to.equal(400)
    const ok = await request(base).post(`/api/dm/messages/${MSG}/hide`)
      .set('x-session-token', token(MEMBER)).send({ userId: MEMBER })
    expect(ok.status).to.equal(200)
    expect(deletionsUpserted.map(d => d.userId)).to.deep.equal([MEMBER])
  })

  it('a read receipt from a member who left is dropped; an active member\'s goes through', async () => {
    const left = await connect(LEFT)
    const member = await connect(MEMBER)
    const owner = await connect(OWNER)
    await settle()
    left.emit('mark-read', { messageIds: [MSG] })
    await settle()
    expect(receiptsCreated).to.have.length(0)
    member.emit('mark-read', { messageIds: [MSG] })
    await settle()
    expect(receiptsCreated.map(r => r.userId)).to.deep.equal([MEMBER])
    expect(events(owner, 'message-read', GROUP).map(([, d]: any) => d.readBy)).to.deep.equal([MEMBER])
  })

  it('a member who left cannot list the group\'s messages', async () => {
    const res = await request(base).get(`/api/dm/conversations/${GROUP}/messages?userId=${LEFT}`)
      .set('x-session-token', token(LEFT))
    expect(res.status).to.equal(500)
  })

  it('an invite join pushes the conversation to active members only', async () => {
    const left = await connect(LEFT)
    const member = await connect(MEMBER)
    await settle()
    const res = await request(base).post('/api/dm/groups/join/some-token')
      .set('x-session-token', token(JOINER)).send({ userId: JOINER })
    expect(res.status).to.equal(200)
    await settle()
    const got = (s: any) => s.got.filter(([e, d]: [string, any]) => e === 'new-conversation' && d?.id === GROUP)
    expect(got(member)).to.have.length(1)
    expect(got(left)).to.have.length(0)
  })

  // A join reads the membership, then joins once the read comes back. These
  // hold that read until the member has left (200, sockets taken out of the
  // room), then let it finish with the membership it saw before.
  const leave = (userId: number) => request(base).post(`/api/dm/groups/${GROUP}/leave`)
    .set('x-session-token', token(userId)).send({ userId })

  it('a join-conversation in flight when the member leaves does not put the socket back', async () => {
    const member = await connect(MEMBER)
    await settle()
    const read = holdNextRead(MEMBER)
    member.emit('join-conversation', GROUP)
    await read.started
    expect((await leave(MEMBER)).status).to.equal(200)
    await settle()
    read.release()
    await settle()
    dmWebSocketService.broadcastMessage({ id: 'g4', conversationId: GROUP, senderId: OWNER })
    await settle()
    expect(events(member, 'new-message', GROUP)).to.have.length(0)
  })

  it('a join-conversation in flight when the member is removed does not put the socket back', async () => {
    const member = await connect(MEMBER)
    await settle()
    const read = holdNextRead(MEMBER)
    member.emit('join-conversation', GROUP)
    await read.started
    const res = await request(base).delete(`/api/dm/groups/${GROUP}/members/${MEMBER}`)
      .set('x-session-token', token(OWNER)).send({ actorUserId: OWNER })
    expect(res.status).to.equal(200)
    await settle()
    read.release()
    await settle()
    dmWebSocketService.broadcastMessage({ id: 'g7', conversationId: GROUP, senderId: OWNER })
    await settle()
    expect(events(member, 'new-message', GROUP)).to.have.length(0)
  })

  it('the rooms joined on connect, read before the member leaves, leave out the group', async () => {
    const read = holdNextRead(MEMBER)
    const member = await connect(MEMBER)
    await read.started
    expect((await leave(MEMBER)).status).to.equal(200)
    await settle()
    read.release()
    await settle()
    dmWebSocketService.broadcastMessage({ id: 'g5', conversationId: GROUP, senderId: OWNER })
    await settle()
    expect(events(member, 'new-message', GROUP)).to.have.length(0)
  })

  // A leave can also land between readMembership's final check and the
  // join. The removal below is queued while the check runs, so it runs before
  // anything that awaits the check's result.
  function leaveRightAfterCheck(userId: number) {
    const removals = (dmWebSocketService as any).removals as Map<number, number>
    const get = removals.get
    const state = { left: false }
    let calls = 0
    removals.get = function (this: Map<number, number>, k: number) {
      if (k === userId && ++calls === 2) {
        removals.get = get
        queueMicrotask(() => {
          rows.find(r => r.conversationId === GROUP && r.userId === userId)!.leftAt = new Date()
          dmWebSocketService.removeUserFromConversation(userId, GROUP)
          state.left = true
        })
      }
      return get.call(this, k)
    }
    return state
  }

  it('a join-conversation whose member leaves right after the membership check does not put the socket back', async () => {
    const member = await connect(MEMBER)
    await settle()
    const leftAfterCheck = leaveRightAfterCheck(MEMBER)
    member.emit('join-conversation', GROUP)
    await settle()
    expect(leftAfterCheck.left).to.equal(true)
    dmWebSocketService.broadcastMessage({ id: 'g8', conversationId: GROUP, senderId: OWNER })
    await settle()
    expect(events(member, 'new-message', GROUP)).to.have.length(0)
  })

  it('the rooms joined on connect leave out a group the member leaves right after the membership check', async () => {
    const leftAfterCheck = leaveRightAfterCheck(MEMBER)
    const member = await connect(MEMBER)
    await settle()
    expect(leftAfterCheck.left).to.equal(true)
    dmWebSocketService.broadcastMessage({ id: 'g9', conversationId: GROUP, senderId: OWNER })
    await settle()
    expect(events(member, 'new-message', GROUP)).to.have.length(0)
  })

  it('a member who leaves and rejoins by invite while a join is in flight is in the room', async () => {
    const member = await connect(MEMBER)
    await settle()
    const read = holdNextRead(MEMBER)
    member.emit('join-conversation', GROUP)
    await read.started
    expect((await leave(MEMBER)).status).to.equal(200)
    const rejoin = await request(base).post('/api/dm/groups/join/some-token')
      .set('x-session-token', token(MEMBER)).send({ userId: MEMBER })
    expect(rejoin.status).to.equal(200)
    read.release()
    await settle()
    dmWebSocketService.broadcastMessage({ id: 'g6', conversationId: GROUP, senderId: OWNER })
    await settle()
    expect(events(member, 'new-message', GROUP)).to.have.length(1)
  })
})

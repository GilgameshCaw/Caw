/**
 * Conversation events that leave out the sender (new-message,
 * message-edited, message-deleted) must reach every other socket in the
 * room once, however many sockets the sender has open, and none of the
 * sender's.
 *
 * Real socket.io server and clients on a random 127.0.0.1 port. The
 * service's auth middleware (session lookup in Redis, username from the
 * DB) is not used: the test's own connection handler registers each socket
 * the way it does and joins the rooms it would. Redis is pointed at a
 * closed port before the service (which loads the session store) is
 * imported.
 */
import { describe, it, before, beforeEach, after } from 'mocha'
import { expect } from 'chai'
import http from 'http'
import type { AddressInfo } from 'net'
import { Server as SocketIOServer } from 'socket.io'
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client'

process.env.REDIS_URL = 'redis://127.0.0.1:1/15'
process.env.NETWORK_ID ||= '1'

const CONV = 'conv-emit-test'
const SENDER = 7
const OTHER = 8
const OTHER2 = 9
const OUTSIDER = 10 // not in CONV

describe('emitToConversation with the sender left out', function () {
  this.timeout(10000)

  let server: http.Server
  let io: SocketIOServer
  let svc: any
  const clients: Array<{ userId: number; socket: ClientSocket; got: string[] }> = []

  async function connect(userId: number, rooms: string[]) {
    const socket = ioClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, {
      transports: ['websocket'],
      auth: { userId, rooms },
    })
    const c = { userId, socket, got: [] as string[] }
    socket.onAny((event: string) => c.got.push(event))
    await new Promise<void>((resolve, reject) => {
      socket.once('ready', () => resolve())
      socket.once('connect_error', reject)
    })
    clients.push(c)
  }

  // Socket.io keeps event order per socket, so once every client has the
  // barrier, everything emitted before it has arrived.
  async function settle() {
    const waits = clients.map(c => new Promise<void>(resolve => c.socket.once('barrier', () => resolve())))
    io.emit('barrier')
    await Promise.all(waits)
    for (const c of clients) c.got = c.got.filter(e => e !== 'barrier')
  }

  const countsFor = (event: string) =>
    clients.map(c => ({ userId: c.userId, n: c.got.filter(e => e === event).length }))

  before(async () => {
    const { DmWebSocketService } = await import('../../../src/services/DmService/websocket')
    svc = new DmWebSocketService()

    server = http.createServer()
    io = new SocketIOServer(server)
    svc.io = io
    io.on('connection', socket => {
      const { userId, rooms } = socket.handshake.auth as { userId: number; rooms: string[] }
      if (!svc.userSockets.has(userId)) svc.userSockets.set(userId, new Set())
      svc.userSockets.get(userId).add(socket.id)
      socket.join(`user:${userId}`)
      for (const r of rooms) socket.join(r)
      socket.on('disconnect', () => svc.userSockets.get(userId)?.delete(socket.id))
      socket.emit('ready')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))

    const room = `conversation:${CONV}`
    for (let i = 0; i < 4; i++) await connect(SENDER, [room])
    await connect(OTHER, [room])
    await connect(OTHER, [room])
    await connect(OTHER2, [room])
    await connect(OUTSIDER, [])
    await settle()
  })

  beforeEach(() => { for (const c of clients) c.got = [] })

  after(async () => {
    for (const c of clients) c.socket.disconnect()
    io?.close()
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  })

  const expected = [
    { userId: SENDER, n: 0 }, { userId: SENDER, n: 0 }, { userId: SENDER, n: 0 }, { userId: SENDER, n: 0 },
    { userId: OTHER, n: 1 }, { userId: OTHER, n: 1 },
    { userId: OTHER2, n: 1 },
    { userId: OUTSIDER, n: 0 },
  ]

  for (const [event, send] of [
    ['message-edited', () => svc.notifyMessageEdited(CONV, 'msg-1', SENDER)],
    ['message-deleted', () => svc.notifyMessageDeleted(CONV, 'msg-1', SENDER)],
    ['new-message', () => svc.broadcastMessage({ id: 'msg-2', conversationId: CONV, senderId: SENDER })],
  ] as Array<[string, () => void]>) {
    it(`${event}: once on each other member's socket, none on the sender's 4`, async () => {
      send()
      await settle()
      expect(countsFor(event)).to.deep.equal(expected)
    })
  }

  it('a sender with no socket open: once on every socket in the room', async () => {
    svc.notifyMessageEdited(CONV, 'msg-3', OUTSIDER + 1)
    await settle()
    expect(countsFor('message-edited').map(c => c.n)).to.deep.equal([1, 1, 1, 1, 1, 1, 1, 0])
  })

  it('reactions still go to everyone in the room, the actor included', async () => {
    svc.notifyReactionToggled(CONV, { messageId: 'msg-1', userId: SENDER, emoji: '+1', added: true })
    await settle()
    expect(countsFor('reaction-added').map(c => c.n)).to.deep.equal([1, 1, 1, 1, 1, 1, 1, 0])
  })
})

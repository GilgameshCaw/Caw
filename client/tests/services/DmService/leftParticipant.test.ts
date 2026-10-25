/**
 * A member who left a group, or was removed from it, keeps their
 * ConversationParticipant row with leftAt set (a re-add reactivates it).
 * The read paths must treat that row as "not in the conversation": the
 * message list, the rooms a socket joins on connect, and the room after the
 * leave.
 *
 * No database: the prisma delegate methods the code calls are replaced for
 * each test and put back after. Redis is pointed at a closed port before
 * the socket service (which loads the session store) is imported, and
 * dm-relay (loaded through DmService) needs a NETWORK_ID at import.
 */
import { describe, it, before, afterEach } from 'mocha'
import { expect } from 'chai'

process.env.REDIS_URL = 'redis://127.0.0.1:1/15'
process.env.NETWORK_ID ||= '1'

const CONV = 'conv-left-test'
const LEFT_USER = 7
const ACTIVE_USER = 8

describe('group members who left', function () {
  let prisma: any
  let getActiveParticipant: typeof import('../../../src/services/DmService/groupService').getActiveParticipant
  let dmService: typeof import('../../../src/services/DmService').default
  let dmWebSocketService: typeof import('../../../src/services/DmService/websocket').default
  const restore: Array<() => void> = []

  function stub(model: string, method: string, fn: (...args: any[]) => any) {
    const delegate = prisma[model]
    const orig = delegate[method]
    prisma[model][method] = fn
    restore.push(() => { prisma[model][method] = orig })
  }

  // Rows as the DB would hold them after LEFT_USER left CONV.
  const rows = [
    { id: 1, conversationId: CONV, userId: LEFT_USER, role: 'MEMBER', leftAt: new Date('2026-10-01T00:00:00Z') },
    { id: 2, conversationId: CONV, userId: ACTIVE_USER, role: 'OWNER', leftAt: null },
    { id: 3, conversationId: 'conv-dm', userId: LEFT_USER, role: 'MEMBER', leftAt: null },
  ]
  function findUniqueByKey(args: any) {
    const k = args.where.conversationId_userId
    return rows.find(r => r.conversationId === k.conversationId && r.userId === k.userId) ?? null
  }
  // Applies the where fields the code under test uses (userId, leftAt).
  function findManyWhere(args: any) {
    return rows.filter(r =>
      (args.where.userId === undefined || r.userId === args.where.userId) &&
      (!('leftAt' in args.where) || r.leftAt === args.where.leftAt))
  }

  before(async () => {
    ;({ prisma } = await import('../../../src/prismaClient'))
    ;({ getActiveParticipant } = await import('../../../src/services/DmService/groupService'))
    dmService = (await import('../../../src/services/DmService')).default
    dmWebSocketService = (await import('../../../src/services/DmService/websocket')).default
  })

  afterEach(() => {
    while (restore.length) restore.pop()!()
  })

  it('getActiveParticipant: a row with leftAt is not a participant', async () => {
    stub('conversationParticipant', 'findUnique', async (args: any) => findUniqueByKey(args))
    expect(await getActiveParticipant(prisma, CONV, LEFT_USER)).to.equal(null)
    expect(await getActiveParticipant(prisma, CONV, ACTIVE_USER)).to.include({ userId: ACTIVE_USER })
    expect(await getActiveParticipant(prisma, CONV, 999)).to.equal(null)
  })

  it('getMessages refuses a member who left, before reading any message', async () => {
    let messagesRead = 0
    stub('conversationParticipant', 'findUnique', async (args: any) => findUniqueByKey(args))
    stub('conversation', 'findUnique', async () => ({ type: 'GROUP' }))
    stub('message', 'findMany', async () => { messagesRead++; return [] })

    let err: any
    try { await dmService.getMessages(CONV, LEFT_USER) } catch (e) { err = e }
    expect(err?.message).to.equal('Not a participant in this conversation')
    expect(messagesRead).to.equal(0)
  })

  it('getMessages still serves an active member', async () => {
    let messagesRead = 0
    stub('conversationParticipant', 'findUnique', async (args: any) => findUniqueByKey(args))
    stub('conversation', 'findUnique', async () => ({ type: 'GROUP' }))
    stub('message', 'findMany', async () => { messagesRead++; return [] })

    const out = await dmService.getMessages(CONV, ACTIVE_USER)
    expect(out.messages).to.deep.equal([])
    expect(messagesRead).to.equal(1)
  })

  it('a connecting socket joins only the rooms of conversations it is still in', async () => {
    stub('conversationParticipant', 'findMany', async (args: any) =>
      findManyWhere(args).map(r => ({ conversationId: r.conversationId })))
    const joined: string[] = []
    const socket = { userId: LEFT_USER, join: (room: string) => { joined.push(room) } }

    await (dmWebSocketService as any).joinUserConversations(socket)
    expect(joined).to.deep.equal(['conversation:conv-dm'])
  })

  it('removeUserFromConversation takes every socket of the user out of the room', () => {
    const calls: Array<[string, string]> = []
    const fakeIo = {
      in: (room: string) => ({ socketsLeave: (leave: string) => { calls.push([room, leave]) } }),
    }
    const svc = dmWebSocketService as any
    const origIo = svc.io
    svc.io = fakeIo
    try {
      svc.removeUserFromConversation(LEFT_USER, CONV)
    } finally {
      svc.io = origIo
    }
    expect(calls).to.deep.equal([[`user:${LEFT_USER}`, `conversation:${CONV}`]])
  })
})

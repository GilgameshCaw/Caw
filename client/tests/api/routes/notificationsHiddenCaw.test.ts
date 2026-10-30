/**
 * GET /api/notifications returned each notification's caw with its content,
 * imageData, videoData and poll, without looking at the caw's status. A hide
 * only flips the caw to HIDDEN and leaves the REPLY / QUOTE / MENTION
 * notifications that point at it, so a reply or quote its author took down
 * (GET /api/caws/:id answers 410) stayed readable in the recipient's list.
 * ACTION_FAILED rows did the same with the target caw's snippet.
 *
 * The real router runs through supertest. prisma, NotificationService, the
 * auth middleware and blockUtils are put in require.cache before
 * notifications.ts loads, so nothing connects to a database. The prisma fake
 * returns only the fields the route selects, so a status the route forgets to
 * select reads as undefined, like the real client.
 */

import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import express from 'express'
import request from 'supertest'

type Row = Record<string, any>

function project(row: Row | null | undefined, select: Row): Row | null {
  if (!row) return null
  const out: Row = {}
  for (const [k, v] of Object.entries(select)) {
    if (v === true) out[k] = row[k]
    else if (v && typeof v === 'object' && 'select' in v) out[k] = project(row[k], v.select)
  }
  return out
}

const BODY = 'the body its author took down'
const cawRow = (id: number, status: string) => ({
  id, status, userId: 2, cawonce: 7,
  content: `${BODY} ::poll:a:b::`,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  hasImage: true, hasVideo: true,
  imageData: 'urls:https://node.example/uploads/images/a1b2c3d4.webp',
  videoData: 'https://node.example/uploads/videos/b2c3d4e5.mp4',
  poll: { id: 9, options: ['a', 'b'], totalVotes: 3, endsAt: null },
  user: { username: 'bob' },
})

let caws: Row[] = []
let notifications: Row[] = []

const prisma = {
  notificationGroup: {
    findMany: async () => notifications.map(n => ({
      id: n.groupId, type: n.type, targetKey: null, count: 1, isRead: false,
      lastEventAt: n.createdAt, openedAt: null, latestNotificationId: n.id,
    })),
    count: async () => 0,
  },
  notification: {
    findMany: async ({ include }: { include: Row }) => notifications.map(n => ({
      ...n,
      actor: { tokenId: 2, username: 'bob' },
      caw: n.cawId == null ? null : project(caws.find(c => c.id === n.cawId), include.caw.select),
      offer: null,
    })),
  },
  user: { findMany: async () => [{ tokenId: 2, username: 'bob' }] },
  caw: {
    findMany: async ({ select }: { select: Row }) => caws.map(c => project(c, select)),
  },
  vote: { groupBy: async () => [] },
  $queryRawUnsafe: async () => [],
}

const stubs: Record<string, unknown> = {
  '../../../src/prismaClient': { prisma },
  '../../../src/services/NotificationService': { NotificationService: {}, createNotificationWithGroup: async () => 0 },
  '../../../src/api/middleware/auth': { requireAuth: () => (_req: unknown, _res: unknown, next: () => void) => next() },
  '../../../src/api/shared/blockUtils': { getBlockedUserIds: async () => [] },
}

const saved = new Map<string, NodeJS.Module | undefined>()
const routePath = require.resolve('../../../src/api/routes/notifications')
let app: express.Express

const notification = (id: number, type: string, cawId: number | null, actionPayload: Row | null = null) => ({
  id, userId: 1, actorId: 2, type, cawId, groupId: 100 + id, groupKey: null,
  isRead: false, hidden: false, actionPayload, createdAt: new Date('2026-10-02T00:00:00Z'),
})

async function list() {
  const res = await request(app).get('/api/notifications').query({ userId: 1 })
  expect(res.status).to.equal(200)
  return res.body.notifications as Row[]
}

describe('GET /api/notifications with a hidden caw', () => {
  before(() => {
    for (const [rel, exports] of Object.entries(stubs)) {
      const p = require.resolve(rel)
      saved.set(p, require.cache[p])
      require.cache[p] = { id: p, filename: p, loaded: true, exports } as NodeJS.Module
    }
    saved.set(routePath, require.cache[routePath])
    delete require.cache[routePath]
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const router = require('../../../src/api/routes/notifications').default
    app = express()
    app.use('/api/notifications', router)
  })

  after(() => {
    for (const [p, mod] of saved) {
      if (mod) require.cache[p] = mod
      else delete require.cache[p]
    }
  })

  for (const type of ['REPLY', 'QUOTE', 'MENTION']) {
    it(`${type}: keeps the link, drops the body, media and poll`, async () => {
      caws = [cawRow(50, 'HIDDEN')]
      notifications = [notification(1, type, 50)]
      const [n] = await list()
      expect(n.caw.id).to.equal(50)
      expect(n.caw.status).to.equal('HIDDEN')
      expect(n.caw.content).to.equal('')
      expect(n.caw.imageData).to.equal(null)
      expect(n.caw.videoData).to.equal(null)
      expect(n.caw.hasImage).to.equal(false)
      expect(n.caw.hasVideo).to.equal(false)
      expect(n.caw.poll).to.equal(null)
      expect(JSON.stringify(n)).to.not.include(BODY)
    })
  }

  it('control: a visible caw is returned whole, with its poll counts', async () => {
    caws = [cawRow(50, 'SUCCESS')]
    notifications = [notification(1, 'REPLY', 50)]
    const [n] = await list()
    expect(n.caw.content).to.include(BODY)
    expect(n.caw.imageData).to.include('a1b2c3d4')
    expect(n.caw.poll.options).to.deep.equal(['a', 'b'])
    expect(n.caw.poll.optionVoteCounts).to.deep.equal([0, 0])
  })

  it("ACTION_FAILED doesn't quote a hidden target caw", async () => {
    caws = [cawRow(50, 'HIDDEN')]
    notifications = [notification(1, 'ACTION_FAILED', null, { receiverId: 2, receiverCawonce: 7 })]
    const [n] = await list()
    expect(n.actionPayload.targetCaw.authorUsername).to.equal('bob')
    expect(n.actionPayload.targetCaw.content).to.equal('')
  })

  it('control: ACTION_FAILED quotes a visible target caw', async () => {
    caws = [cawRow(50, 'SUCCESS')]
    notifications = [notification(1, 'ACTION_FAILED', null, { receiverId: 2, receiverCawonce: 7 })]
    const [n] = await list()
    expect(n.actionPayload.targetCaw.content).to.include(BODY)
  })
})

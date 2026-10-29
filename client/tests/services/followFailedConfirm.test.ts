/**
 * A follow tx the validator gave up on can still land on chain (the
 * validator marked it failed, but the batch actually went through). The
 * failure path (markTxQueueFailed -> cleanupOptimisticRows) flips the
 * Follow row to FAILED and takes the counts off. When the indexer then sees
 * the FOLLOW on chain, handleFollowAction has to put the counts back and
 * send the follow notification, as handleRecawAction does for a FAILED
 * recaw. It used to do neither: the follower/following counters stayed one
 * low and the followed user was never notified.
 *
 * In-memory prisma; the real markTxQueueFailed, handleFollowAction and
 * CountManager. No database, Redis, Elasticsearch or RPC.
 */
process.env.ELASTICSEARCH_NODE = 'http://127.0.0.1:1'
process.env.REDIS_URL = 'redis://127.0.0.1:1'
delete process.env.DATABASE_URL

import { describe, it, before } from 'mocha'
import { expect } from 'chai'

type Follow = { id: number; followerId: number; followingId: number; action: string; status: string }

const db = {
  users: new Map<number, any>(),
  follows: [] as Follow[],
  notifications: [] as any[],
  txQueue: new Map<number, any>(),
}

function match(row: any, where: any): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === 'followerId_followingId') return match(row, v)
    return row[k] === v
  })
}

// Reads hand back a copy, as Prisma does: txQueueFailure.ts reads the row,
// updates it, then checks what it read.
const copy = <T>(r: T | undefined): T | null => (r ? { ...r } : null)

const follow = {
  async findUnique({ where }: any) { return copy(db.follows.find(f => match(f, where))) },
  async update({ where, data }: any) {
    const f = db.follows.find(r => match(r, where))!
    Object.assign(f, data); return f
  },
  async updateMany({ where, data }: any) {
    const rows = db.follows.filter(r => match(r, where))
    for (const r of rows) Object.assign(r, data)
    return { count: rows.length }
  },
  async upsert({ where, update, create }: any) {
    const f = db.follows.find(r => match(r, where))
    if (f) { Object.assign(f, update); return f }
    const n = { id: 100 + db.follows.length, ...create }; db.follows.push(n); return n
  },
}
const user = {
  async findUnique({ where }: any) { return db.users.get(where.tokenId) ?? null },
  async update({ where, data }: any) {
    const u = db.users.get(where.tokenId)
    for (const [k, v] of Object.entries<any>(data)) u[k] = typeof v === 'object' ? u[k] + v.increment : v
    return u
  },
}
const notification = {
  async findFirst({ where }: any) { return db.notifications.find(n => match(n, where)) ?? null },
  async create({ data }: any) {
    const n = { id: db.notifications.length + 1, cawId: null, offerId: null, createdAt: new Date(), ...data }
    db.notifications.push(n); return n
  },
  async update({ where, data }: any) {
    const n = db.notifications.find(r => r.id === where.id)!
    Object.assign(n, data); return n
  },
}
const txQueue = {
  async findUnique({ where }: any) { return db.txQueue.get(where.id) ?? null },
  async update({ where, data }: any) {
    const r = db.txQueue.get(where.id)!
    Object.assign(r, data); return r
  },
}
// safeDecrement's SQL, read back literally.
async function $executeRawUnsafe(sql: string, amount: number, id: number) {
  const m = sql.match(/^UPDATE "User" SET "(\w+)" = GREATEST\(0, "\1" - \$1\) WHERE "tokenId" = \$2$/)
  if (!m) throw new Error(`unexpected SQL: ${sql}`)
  const u = db.users.get(id)
  if (!u) return 0
  u[m[1]] = Math.max(0, u[m[1]] - amount)
  return 1
}
// createNotificationWithGroup's NotificationGroup upsert.
async function $queryRawUnsafe(sql: string) {
  if (!sql.includes('INSERT INTO "NotificationGroup"')) throw new Error(`unexpected SQL: ${sql}`)
  return [{ id: 1 }]
}
const tx: any = { follow, user, notification, txQueue, $executeRawUnsafe, $queryRawUnsafe }

const A = 801, B = 802
const FOLLOW = 4

function seed(status: string) {
  db.users = new Map([A, B].map(id => [id, {
    tokenId: id, username: `u${id}`, followerCount: 5, followingCount: 5,
  }]))
  db.follows = [{ id: 1, followerId: A, followingId: B, action: 'FOLLOW', status }]
  db.notifications = []
  db.txQueue = new Map([[1, { id: 1, batchId: null, status: 'processing', reason: null }]])
}

let handleFollowAction: any, markTxQueueFailed: any

const counts = () => ({ B_followers: db.users.get(B).followerCount, A_following: db.users.get(A).followingCount })
const followNotifs = () => db.notifications.filter(n => n.type === 'FOLLOW' && n.userId === B && n.actorId === A)
const rowAB = () => db.follows.find(f => f.followerId === A && f.followingId === B)!
const indexFollowAB = () => handleFollowAction(tx, { senderId: A }, { receiverId: B })

describe('handleFollowAction: a FAILED follow that lands on chain', function () {
  this.timeout(20000)

  before(async () => {
    const { prisma } = await import('../../src/prismaClient')
    Object.defineProperty(prisma, 'user', { value: user, configurable: true, writable: true })
    ;({ handleFollowAction } = await import('../../src/services/ActionProcessor/actionHandlers'))
    ;({ markTxQueueFailed } = await import('../../src/utils/txQueueFailure'))
  })

  it('puts back the counts the failure took off and notifies once', async () => {
    seed('PENDING')
    const before = counts()

    // The validator gives up on the row (same raw reason as a cawonce-used
    // rejection, which skips the ACTION_FAILED notification).
    await markTxQueueFailed(tx, 1, 'Cawonce already used', A, { actionType: FOLLOW, receiverId: B, cawonce: 0 })
    expect(rowAB().status).to.equal('FAILED')
    expect(counts()).to.deep.equal({ B_followers: before.B_followers - 1, A_following: before.A_following - 1 })

    // The chain says it landed.
    await indexFollowAB()
    expect(rowAB()).to.include({ action: 'FOLLOW', status: 'SUCCESS' })
    expect(counts()).to.deep.equal(before)
    expect(followNotifs()).to.have.length(1)
  })

  it('a re-pass of the same FOLLOW changes nothing', async () => {
    seed('FAILED')
    await indexFollowAB()
    const after = counts()
    await indexFollowAB()
    expect(counts()).to.deep.equal(after)
    expect(followNotifs()).to.have.length(1)
  })

  it('a PENDING follow confirming is still a count no-op with one notification', async () => {
    seed('PENDING')
    const before = counts()
    await indexFollowAB()
    expect(rowAB().status).to.equal('SUCCESS')
    expect(counts()).to.deep.equal(before)
    expect(followNotifs()).to.have.length(1)
  })
})

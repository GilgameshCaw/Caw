/**
 * The optimistic FOLLOW (actions.ts) counts a PENDING follow at submit time.
 * GET /api/users/:username recounts follows from the Follow table and writes
 * the result back to the User row, so the recount has to count a PENDING
 * FOLLOW as well. If it doesn't, a profile view between submit and confirm
 * drops the follow from the counter, and the confirm (no count change) or a
 * failure (decrement) leaves it one low.
 *
 * In-memory prisma; the real users.ts GET handler, handleFollowAction and
 * CountManager. The submit is replayed as its two writes (PENDING row +
 * countManager.onFollowCreated). No database, Redis, Elasticsearch or RPC.
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
}

function match(row: any, where: any): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === 'followerId_followingId') return match(row, v)
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k])
    return row[k] === v
  })
}

const follow = {
  async findUnique({ where }: any) { return db.follows.find(f => match(f, where)) ?? null },
  async upsert({ where, update, create }: any) {
    const f = db.follows.find(r => match(r, where))
    if (f) { Object.assign(f, update); return f }
    const n = { id: 100 + db.follows.length, ...create }; db.follows.push(n); return n
  },
  async update({ where, data }: any) {
    const f = db.follows.find(r => match(r, where))!
    Object.assign(f, data); return f
  },
  async count({ where }: any) { return db.follows.filter(f => match(f, where)).length },
}
const user = {
  async findUnique({ where }: any) {
    if (where.username) return [...db.users.values()].find(u => u.username === where.username) ?? null
    return db.users.get(where.tokenId) ?? null
  },
  async update({ where, data }: any) {
    const u = db.users.get(where.tokenId)
    for (const [k, v] of Object.entries<any>(data)) u[k] = typeof v === 'object' ? u[k] + v.increment : v
    return u
  },
}
const none = { async count() { return 0 } }
const walletXLink = { async findUnique() { return null } }
// safeDecrement's SQL, read back literally.
async function $executeRawUnsafe(sql: string, amount: number, id: number) {
  const m = sql.match(/^UPDATE "User" SET "(\w+)" = GREATEST\(0, "\1" - \$1\) WHERE "tokenId" = \$2$/)
  if (!m) throw new Error(`unexpected SQL: ${sql}`)
  const u = db.users.get(id)
  if (!u) return 0
  u[m[1]] = Math.max(0, u[m[1]] - amount)
  return 1
}
const notification = new Proxy({}, { get: () => async () => null })
const tx: any = { follow, user, notification, $executeRawUnsafe, $queryRawUnsafe: async () => [] }

const A = 701, B = 702, C = 703, D = 704
const name = (id: number) => `u${id}`

// C -> B and A -> D confirmed; counters match.
function seed(extra: Array<[number, number, string, string]> = []) {
  db.users = new Map([A, B, C, D].map(id => [id, {
    tokenId: id, username: name(id), address: null,
    cawCount: 0, recawCount: 0, likedCount: 0, likesReceivedCount: 0,
    followerCount: 0, followingCount: 0,
  }]))
  db.follows = [[C, B, 'FOLLOW', 'SUCCESS'], [A, D, 'FOLLOW', 'SUCCESS'], ...extra]
    .map(([f, t, action, status], i) => ({ id: i + 1, followerId: f as number, followingId: t as number, action: action as string, status: status as string }))
  for (const f of db.follows) {
    if (f.action === 'FOLLOW' && f.status === 'SUCCESS') {
      db.users.get(f.followingId).followerCount++
      db.users.get(f.followerId).followingCount++
    }
  }
}

let getProfile: any, handleFollowAction: any, countManager: any

async function recount(id: number) {
  let json: any
  const res: any = { status() { return res }, json(j: any) { json = j; return res } }
  await getProfile({ params: { username: name(id) }, header: () => undefined }, res)
  await new Promise(r => setImmediate(r)) // the drift write-back is fire-and-forget
  return json
}
async function submitFollowAB() {
  await follow.upsert({
    where: { followerId_followingId: { followerId: A, followingId: B } },
    update: { status: 'PENDING', action: 'FOLLOW' },
    create: { followerId: A, followingId: B, action: 'FOLLOW', status: 'PENDING' },
  })
  await countManager.onFollowCreated(tx, { followerId: A, followingId: B })
}
const counts = () => ({ B_followers: db.users.get(B).followerCount, A_following: db.users.get(A).followingCount })
const pendingAB = () => db.follows.find(f => f.followerId === A && f.followingId === B)!

describe('GET /api/users/:username: follow recount counts a pending FOLLOW', function () {
  this.timeout(20000)

  before(async () => {
    const { prisma } = await import('../../../src/prismaClient')
    for (const [k, v] of Object.entries({ follow, user, like: none, caw: none, walletXLink })) {
      Object.defineProperty(prisma, k, { value: v, configurable: true, writable: true })
    }
    ;({ handleFollowAction } = await import('../../../src/services/ActionProcessor/actionHandlers'))
    ;({ countManager } = await import('../../../src/services/CountManager'))
    const router: any = (await import('../../../src/api/routes/users')).default
    const l = router.stack.find((x: any) => x.route?.path === '/:username' && x.route.methods.get)
    getProfile = l.route.stack[l.route.stack.length - 1].handle
  })

  it('submit, then a profile view: the pending follow stays counted', async () => {
    seed()
    await submitFollowAB()
    expect((await recount(B)).followerCount).to.equal(2)
    expect((await recount(A)).followingCount).to.equal(2)
    expect(counts()).to.deep.equal({ B_followers: 2, A_following: 2 })
  })

  it('submit, profile view, confirm: 2, not 1', async () => {
    seed()
    await submitFollowAB()
    await recount(B); await recount(A)
    await handleFollowAction(tx, { senderId: A }, { receiverId: B })
    expect(pendingAB().status).to.equal('SUCCESS')
    expect(counts()).to.deep.equal({ B_followers: 2, A_following: 2 })
  })

  it('submit, profile view, tx fails (PENDING -> FAILED rollback): back to 1, not 0', async () => {
    seed()
    await submitFollowAB()
    await recount(B); await recount(A)
    pendingAB().status = 'FAILED'
    await countManager.onStatusChanged(tx, 'follow', pendingAB().id, 'PENDING', 'FAILED', { followerId: A, followingId: B })
    expect(counts()).to.deep.equal({ B_followers: 1, A_following: 1 })
  })

  it('control: submit, confirm, profile view: 2', async () => {
    seed()
    await submitFollowAB()
    await handleFollowAction(tx, { senderId: A }, { receiverId: B })
    await recount(B); await recount(A)
    expect(counts()).to.deep.equal({ B_followers: 2, A_following: 2 })
  })

  it('a pending UNFOLLOW and a FAILED FOLLOW are not counted, and drift is still healed', async () => {
    seed([[A, B, 'UNFOLLOW', 'PENDING'], [D, B, 'FOLLOW', 'FAILED']])
    db.users.get(B).followerCount = 5
    expect((await recount(B)).followerCount).to.equal(1)
    expect(db.users.get(B).followerCount).to.equal(1)
  })
})

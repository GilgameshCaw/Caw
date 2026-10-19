import { expect } from 'chai'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../helpers/test-setup'
import { mergeFeedRows, fetchSplitFeed, MAX_FOLLOWED_IN_LIST } from '../../src/api/shared/feedPage'

// These tests write to the database. They fail (not skip) anywhere but a caw_test_ database,
// so a misconfigured run cannot pass silently.
const SAFE_DB = (process.env.DATABASE_URL || '').includes('caw_test_')

const VIEWER = 9101
const AUTHOR = 9102
const BLOCKED = 9103
const OTHER = 9104
const T0 = Date.parse('2026-10-01T00:00:00Z')
const at = (minutes: number) => new Date(T0 + minutes * 60_000)

type Status = 'SUCCESS' | 'PENDING' | 'FAILED' | 'HIDDEN'

describe('mergeFeedRows (no database)', () => {
  const at = (ms: number) => new Date(ms)
  it('keeps one copy of an id that appears in both halves', () => {
    const pub = [{ id: 5, createdAt: at(3000) }, { id: 4, createdAt: at(2000) }]
    const own = [{ id: 5, createdAt: at(3000) }, { id: 9, createdAt: at(2500) }]
    expect(mergeFeedRows(pub, own, 10).map((r) => r.id)).to.deep.equal([5, 9, 4])
  })
  it('orders by createdAt desc, then id desc, and cuts to take', () => {
    const pub = [{ id: 1, createdAt: at(1000) }, { id: 7, createdAt: at(1000) }]
    const own = [{ id: 3, createdAt: at(2000) }, { id: 2, createdAt: at(1000) }]
    expect(mergeFeedRows(pub, own, 3).map((r) => r.id)).to.deep.equal([3, 7, 2])
  })
})
type Fixture = { id: number; userId: number; status: Status; createdAt: Date }

describe('GET /api/caws: logged-in home feed', function () {
  this.timeout(60_000)
  let app: Express
  let fixtures: Fixture[] = []

  before(() => {
    if (!SAFE_DB) throw new Error('feedSplit tests need DATABASE_URL to name a caw_test_ database')
    // Loading the routers starts a full sync to Elasticsearch. Point it at an address nothing listens on.
    process.env.ELASTICSEARCH_NODE = 'http://127.0.0.1:1'
    const { createTestApp } = require('../helpers/test-setup')
    app = createTestApp()
  })

  // The shared cleanDatabase() helper still deletes a removed model (scheduledCaw) and throws,
  // so this suite clears only the tables it writes.
  async function resetRows() {
    await prisma.block.deleteMany()
    await prisma.caw.deleteMany()
    await prisma.user.deleteMany()
  }

  beforeEach(async () => {
    await resetRows()
    for (const tokenId of [VIEWER, AUTHOR, BLOCKED, OTHER]) {
      // User.id has no default in the current schema, so set it explicitly (same value as tokenId).
      await prisma.user.create({ data: { id: tokenId, tokenId, username: `feedsplit_${tokenId}` } })
    }
    await prisma.block.create({ data: { blockerId: VIEWER, blockedId: BLOCKED } })

    // [author, status, minutes after T0]. Several share a timestamp on purpose (tie-break by id).
    const specs: Array<[number, Status, number]> = [
      [AUTHOR, 'SUCCESS', 10], [AUTHOR, 'SUCCESS', 10],
      [VIEWER, 'PENDING', 10], [VIEWER, 'FAILED', 9], [VIEWER, 'SUCCESS', 5], [VIEWER, 'PENDING', 3],
      [OTHER, 'PENDING', 11], [OTHER, 'FAILED', 8],
      [AUTHOR, 'HIDDEN', 12], [BLOCKED, 'SUCCESS', 13],
    ]
    for (let i = 1; i <= 25; i++) specs.push([AUTHOR, 'SUCCESS', i % 7])

    const cawonce: Record<number, number> = {}
    fixtures = []
    for (const [userId, status, minutes] of specs) {
      cawonce[userId] = (cawonce[userId] || 0) + 1
      const row = await prisma.caw.create({
        data: { userId, content: `feed ${userId}-${cawonce[userId]}`, action: 'CAW', cawonce: cawonce[userId], status, createdAt: at(minutes) },
      })
      fixtures.push({ id: row.id, userId, status, createdAt: row.createdAt })
    }
  })

  afterEach(async () => {
    await resetRows()
  })

  // Independent oracle: the rows the viewer should see, in feed order (createdAt desc, id desc).
  function expectedIds(viewer: number | undefined): number[] {
    return fixtures
      .filter((f) => {
        if (viewer === VIEWER && f.userId === BLOCKED) return false
        if (f.status === 'SUCCESS') return true
        return viewer !== undefined && f.userId === viewer && (f.status === 'PENDING' || f.status === 'FAILED')
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id)
      .map((f) => f.id)
  }

  // Walks every page through nextCursor, the way the web client does.
  async function collect(limit: number, headers: Record<string, string>): Promise<number[]> {
    const ids: number[] = []
    let cursor: number | undefined
    for (let guard = 0; guard < 500; guard++) {
      const query = cursor ? `&cursor=${cursor}` : ''
      const res = await request(app).get(`/api/caws?limit=${limit}${query}`).set(headers)
      expect(res.status).to.equal(200)
      ids.push(...res.body.items.map((item: any) => Number(item.id)))
      if (!res.body.nextCursor) break
      cursor = Number(res.body.nextCursor)
    }
    return ids
  }

  it('logged-in: every page size yields the expected order, with no duplicates or gaps', async () => {
    for (const limit of [1, 2, 5, 20]) {
      const got = await collect(limit, { 'x-user-id': String(VIEWER) })
      expect(got, `limit=${limit}`).to.deep.equal(expectedIds(VIEWER))
    }
  })

  it('logged-in: shows own PENDING/FAILED, hides other users PENDING/FAILED, HIDDEN and blocked authors', async () => {
    const got = await collect(20, { 'x-user-id': String(VIEWER) })
    const byId = new Map(fixtures.map((f) => [f.id, f]))
    for (const id of got) {
      const f = byId.get(id)!
      const own = f.userId === VIEWER
      expect(f.status === 'SUCCESS' || (own && (f.status === 'PENDING' || f.status === 'FAILED')), `id=${id}`).to.equal(true)
      expect(f.userId, `id=${id}`).to.not.equal(BLOCKED)
    }
    expect(got.length).to.equal(expectedIds(VIEWER).length)
  })

  it('a post hidden after it was picked is not returned, and the page is still filled', async () => {
    const expected = expectedIds(VIEWER)
    let hidden = false
    const got = await fetchSplitFeed({
      viewerId: VIEWER,
      extraAnd: [{ userId: { notIn: [BLOCKED] } }],
      take: 5,
      include: undefined,
      afterPick: async (ids) => {
        if (hidden) return
        hidden = true
        await prisma.caw.update({ where: { id: ids[0] }, data: { status: 'HIDDEN' } })
      },
    })
    expect(got.map((r: any) => r.id)).to.deep.equal(expected.slice(1, 6))
  })

  it('a cursor that points at a HIDDEN post continues with the posts older than it (intended change)', async () => {
    const expected = expectedIds(VIEWER)
    const k = 3
    await prisma.caw.update({ where: { id: expected[k] }, data: { status: 'HIDDEN' } })
    const res = await request(app).get(`/api/caws?limit=3&cursor=${expected[k]}`).set({ 'x-user-id': String(VIEWER) })
    expect(res.status).to.equal(200)
    expect(res.body.items.map((item: any) => Number(item.id))).to.deep.equal(expected.slice(k + 1, k + 4))
  })

  it('anonymous: only SUCCESS posts, paged in the same order', async () => {
    const got = await collect(5, {})
    expect(got).to.deep.equal(expectedIds(undefined))
  })
})

describe('GET /api/caws?filter=following', function () {
  this.timeout(120_000)
  let app: Express
  const V = 9201       // viewer
  const F1 = 9202      // followed
  const F2 = 9203      // followed
  const UNF = 9204     // follow row exists but action is UNFOLLOW
  const PEND = 9205    // follow row exists but is still PENDING
  const BLK = 9206     // followed and blocked
  const NF = 9207      // not followed
  const ZERO = 9208    // follows nobody
  const MANY = 9209    // follows more accounts than MAX_FOLLOWED_IN_LIST
  const BULK = 20_000  // first tokenId of the accounts MANY follows
  const T0 = Date.parse('2026-10-01T00:00:00Z')
  const at = (minutes: number) => new Date(T0 + minutes * 60_000)
  type Row = { id: number; userId: number; status: Status; createdAt: Date }
  let rows: Row[] = []

  before(() => {
    if (!SAFE_DB) throw new Error('feedSplit tests need DATABASE_URL to name a caw_test_ database')
    process.env.ELASTICSEARCH_NODE = 'http://127.0.0.1:1'
    const { createTestApp } = require('../helpers/test-setup')
    app = createTestApp()
  })

  async function resetRows() {
    await prisma.follow.deleteMany()
    await prisma.block.deleteMany()
    await prisma.caw.deleteMany()
    await prisma.user.deleteMany()
  }

  beforeEach(async () => {
    await resetRows()
    for (const tokenId of [V, F1, F2, UNF, PEND, BLK, NF, ZERO, MANY]) {
      await prisma.user.create({ data: { id: tokenId, tokenId, username: `following_${tokenId}` } })
    }
    // Accounts that MANY follows. Only the first one posts.
    const bulk = Array.from({ length: MAX_FOLLOWED_IN_LIST + 1 }, (_, i) => BULK + i)
    await prisma.user.createMany({ data: bulk.map((tokenId) => ({ id: tokenId, tokenId, username: `following_bulk_${tokenId}` })) })
    await prisma.follow.createMany({ data: bulk.map((followingId) => ({ followerId: MANY, followingId, action: 'FOLLOW', status: 'SUCCESS' })) })
    await prisma.follow.createMany({
      data: [
        { followerId: V, followingId: F1, action: 'FOLLOW', status: 'SUCCESS' },
        { followerId: V, followingId: F2, action: 'FOLLOW', status: 'SUCCESS' },
        { followerId: V, followingId: UNF, action: 'UNFOLLOW', status: 'SUCCESS' },
        { followerId: V, followingId: PEND, action: 'FOLLOW', status: 'PENDING' },
        { followerId: V, followingId: BLK, action: 'FOLLOW', status: 'SUCCESS' },
      ],
    })
    await prisma.block.create({ data: { blockerId: V, blockedId: BLK } })

    const specs: Array<[number, Status, number]> = [
      [F1, 'SUCCESS', 10], [F1, 'SUCCESS', 10], [F2, 'SUCCESS', 7], [F1, 'HIDDEN', 12], [F2, 'PENDING', 11], [F1, 'FAILED', 6],
      [UNF, 'SUCCESS', 9], [PEND, 'SUCCESS', 8], [BLK, 'SUCCESS', 13], [NF, 'SUCCESS', 14], [NF, 'PENDING', 15],
      [V, 'SUCCESS', 5], [V, 'PENDING', 4], [V, 'FAILED', 3], [V, 'PENDING', 10], [V, 'HIDDEN', 2],
      [ZERO, 'SUCCESS', 1], [ZERO, 'PENDING', 2], [ZERO, 'FAILED', 3],
      [BULK, 'SUCCESS', 6], [BULK, 'SUCCESS', 6], [MANY, 'PENDING', 9], [BULK + 1, 'SUCCESS', 20],
    ]
    for (let i = 1; i <= 25; i++) specs.push([F1, 'SUCCESS', i % 7])
    const cawonce: Record<number, number> = {}
    rows = []
    for (const [userId, status, minutes] of specs) {
      cawonce[userId] = (cawonce[userId] || 0) + 1
      const r = await prisma.caw.create({
        data: { userId, content: `following ${userId}-${cawonce[userId]}`, action: 'CAW', cawonce: cawonce[userId], status, createdAt: at(minutes) },
      })
      rows.push({ id: r.id, userId, status, createdAt: r.createdAt })
    }
  })

  afterEach(async () => {
    await resetRows()
  })

  // Independent oracle: posts by me or by confirmed follows (not blocked), SUCCESS for everyone,
  // PENDING/FAILED only my own, in feed order.
  function expectedIds(viewer: number, followed: number[], blocked: number[]): number[] {
    return rows
      .filter((r) => {
        if (blocked.includes(r.userId)) return false
        const mine = r.userId === viewer
        if (!mine && !followed.includes(r.userId)) return false
        if (r.status === 'SUCCESS') return true
        return mine && (r.status === 'PENDING' || r.status === 'FAILED')
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id)
      .map((r) => r.id)
  }

  async function collect(limit: number, viewer: number): Promise<number[]> {
    const ids: number[] = []
    let cursor: number | undefined
    for (let guard = 0; guard < 500; guard++) {
      const query = cursor ? `&cursor=${cursor}` : ''
      const res = await request(app).get(`/api/caws?limit=${limit}&filter=following${query}`).set({ 'x-user-id': String(viewer) })
      expect(res.status).to.equal(200)
      ids.push(...res.body.items.map((item: any) => Number(item.id)))
      if (!res.body.nextCursor) break
      cursor = Number(res.body.nextCursor)
    }
    return ids
  }

  it('shows my own posts of every visible status and confirmed follows, in order, for every page size', async () => {
    for (const limit of [1, 2, 5, 20]) {
      expect(await collect(limit, V), `limit=${limit}`).to.deep.equal(expectedIds(V, [F1, F2], [BLK]))
    }
  })

  it('leaves out unfollowed, pending-follow, blocked and not-followed authors, and other users PENDING/FAILED', async () => {
    const got = new Set(await collect(50, V))
    for (const r of rows) {
      if ([UNF, PEND, BLK, NF].includes(r.userId)) expect(got.has(r.id), `id=${r.id} user=${r.userId}`).to.equal(false)
      if (r.userId === F2 && r.status === 'PENDING') expect(got.has(r.id)).to.equal(false)
      if (r.status === 'HIDDEN') expect(got.has(r.id)).to.equal(false)
    }
  })

  it('a viewer who follows nobody sees only their own posts, including PENDING and FAILED', async () => {
    const got = await collect(2, ZERO)
    expect(got).to.deep.equal(expectedIds(ZERO, [], []))
    expect(got.length).to.equal(3)
  })

  it('a viewer who follows more accounts than the IN-list limit gets the same result', async () => {
    for (const limit of [2, 20]) {
      const got = await collect(limit, MANY)
      expect(got, `limit=${limit}`).to.deep.equal(expectedIds(MANY, Array.from({ length: MAX_FOLLOWED_IN_LIST + 1 }, (_, i) => BULK + i), []))
      expect(got.length).to.be.greaterThan(0)
    }
  })
})

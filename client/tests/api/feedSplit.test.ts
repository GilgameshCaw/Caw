import { expect } from 'chai'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../helpers/test-setup'
import { mergeFeedRows, fetchSplitFeed } from '../../src/api/shared/feedPage'

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

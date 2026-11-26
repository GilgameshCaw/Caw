/**
 * POST /api/reports: the author of the reported post comes from the post, and a
 * report a moderator has decided is not overwritten by a second report.
 *
 * The decisions live in src/api/shared/reportSubmit.ts and are tested here with a
 * stand-in for the database, so that part needs nothing running. The last block
 * goes through the real route, with a real database and real sessions, and
 * SKIPS unless DATABASE_URL points at a caw_test_* database (see
 * tests/api/routes/followLists.test.ts for the same convention):
 *
 *   DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/caw_test_reports \
 *   npx mocha --import=tsx --exit tests/api/routes/reportsPost.test.ts
 *
 * It also needs the Redis that tests/helpers/isolatedEnv.ts points at
 * (redis://127.0.0.1:6379/15), and skips itself when that does not answer.
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { ReportReason, ReportStatus } from '@prisma/client'
import { parsePositiveInt, submitPostReport, type ReportDb } from '../../../src/api/shared/reportSubmit'

// ─── A stand-in for the two tables the function reads and writes ────────────

interface FakeReport {
  id: number
  reporterId: number
  postId: number
  postAuthorId: number
  reason: ReportReason
  details: string | null
  status: ReportStatus
  reviewedAt: Date | null
  reviewedBy: string | null
  resolution: string | null
}

function fakeDb(posts: Array<{ id: number; userId: number }>, reports: FakeReport[] = []) {
  let nextId = 100
  const db = {
    caw: {
      findUnique: async ({ where }: any) => posts.find(p => p.id === where.id) ?? null,
    },
    report: {
      findFirst: async ({ where }: any) =>
        reports.find(r => r.reporterId === where.reporterId && r.postId === where.postId) ?? null,
      update: async ({ where, data }: any) => {
        const r = reports.find(x => x.id === where.id)!
        Object.assign(r, data)
        return r
      },
      create: async ({ data }: any) => {
        const r: FakeReport = { id: nextId++, reviewedAt: null, reviewedBy: null, resolution: null, ...data }
        reports.push(r)
        return r
      },
    },
  }
  return { db: db as unknown as ReportDb, reports }
}

const decidedReport = (status: ReportStatus): FakeReport => ({
  id: 7, reporterId: 2, postId: 50, postAuthorId: 3, reason: ReportReason.SPAM, details: 'first',
  status, reviewedAt: new Date('2026-11-01T00:00:00Z'), reviewedBy: '1', resolution: `decided ${status}`,
})

describe('parsePositiveInt', () => {
  it('takes whole numbers above zero, as numbers or strings of digits', () => {
    expect(parsePositiveInt(5)).to.equal(5)
    expect(parsePositiveInt('5')).to.equal(5)
    expect(parsePositiveInt(' 12 ')).to.equal(12)
  })
  it('refuses everything else', () => {
    for (const v of [0, -5, 1.5, '1.5', '-5', 'abc', '', ' ', '0', NaN, Infinity, null, undefined, {}, [], [3], true, '1e3', '0x10']) {
      expect(parsePositiveInt(v), JSON.stringify(v)).to.equal(null)
    }
  })
})

describe('submitPostReport', () => {
  const posts = [{ id: 50, userId: 3 }]

  it('files a report and takes the author from the post', async () => {
    const { db, reports } = fakeDb(posts)
    const res = await submitPostReport(db, { reporterId: 2, postId: 50, reason: ReportReason.SPAM, details: 'x' })
    expect(res.status).to.equal(201)
    expect(reports).to.have.lengthOf(1)
    expect(reports[0]).to.include({ reporterId: 2, postId: 50, postAuthorId: 3, status: ReportStatus.PENDING, details: 'x' })
  })

  it('takes a post id sent as a string', async () => {
    const { db, reports } = fakeDb(posts)
    expect((await submitPostReport(db, { reporterId: 2, postId: '50', reason: ReportReason.SPAM })).status).to.equal(201)
    expect(reports[0].postId).to.equal(50)
  })

  it('answers 404 for a post that does not exist, and stores nothing', async () => {
    const { db, reports } = fakeDb(posts)
    const res = await submitPostReport(db, { reporterId: 2, postId: 999999, reason: ReportReason.SPAM })
    expect(res.status).to.equal(404)
    expect(reports).to.have.lengthOf(0)
  })

  it('answers 400 for a post id that is not a positive whole number, or does not fit the column', async () => {
    for (const postId of ['abc', -5, 0, 1.5, '1.5', 99999999999, null, undefined, {}]) {
      const { db, reports } = fakeDb(posts)
      const res = await submitPostReport(db, { reporterId: 2, postId, reason: ReportReason.SPAM })
      expect(res.status, JSON.stringify(postId)).to.equal(400)
      expect(reports, JSON.stringify(postId)).to.have.lengthOf(0)
    }
  })

  for (const decided of [ReportStatus.REVIEWED, ReportStatus.ACTIONED, ReportStatus.DISMISSED]) {
    it(`leaves a ${decided} report as the moderator left it`, async () => {
      const original = decidedReport(decided)
      const { db, reports } = fakeDb(posts, [{ ...original }])
      const res = await submitPostReport(db, { reporterId: 2, postId: 50, reason: ReportReason.HARASSMENT, details: 'second' })
      expect(res.status).to.equal(200)
      expect(res.body.success).to.equal(true)
      expect(res.body.reportId).to.equal(7)
      expect(reports).to.have.lengthOf(1)
      expect(reports[0]).to.deep.equal(original)
    })
  }

  it('answers a decided report exactly as it answers an update of a pending one, whatever the decision was', async () => {
    const pending: FakeReport = { ...decidedReport(ReportStatus.PENDING), reviewedAt: null, reviewedBy: null, resolution: null }
    const update = await submitPostReport(fakeDb(posts, [pending]).db, { reporterId: 2, postId: 50, reason: ReportReason.SPAM })
    for (const decided of [ReportStatus.REVIEWED, ReportStatus.ACTIONED, ReportStatus.DISMISSED]) {
      const { db } = fakeDb(posts, [decidedReport(decided)])
      const res = await submitPostReport(db, { reporterId: 2, postId: 50, reason: ReportReason.SPAM })
      expect(res, decided).to.deep.equal(update)
    }
  })

  it('updates the reason and details of a report that is still pending', async () => {
    const pending: FakeReport = { ...decidedReport(ReportStatus.PENDING), reviewedAt: null, reviewedBy: null, resolution: null }
    const { db, reports } = fakeDb(posts, [pending])
    const res = await submitPostReport(db, { reporterId: 2, postId: 50, reason: ReportReason.HARASSMENT, details: 'second' })
    expect(res.status).to.equal(200)
    expect(res.body.message).to.equal('Report updated')
    expect(reports).to.have.lengthOf(1)
    expect(reports[0]).to.include({ reason: ReportReason.HARASSMENT, details: 'second', status: ReportStatus.PENDING })
  })

  it('does not touch another reporter\'s decided report, and files a new one', async () => {
    const other = { ...decidedReport(ReportStatus.DISMISSED), reporterId: 9 }
    const { db, reports } = fakeDb(posts, [{ ...other }])
    const res = await submitPostReport(db, { reporterId: 2, postId: 50, reason: ReportReason.SPAM })
    expect(res.status).to.equal(201)
    expect(reports).to.have.lengthOf(2)
    expect(reports[0]).to.deep.equal(other)
  })
})

// ─── Through the real route ─────────────────────────────────────────────────

const HAS_TEST_DB = /\/caw_test_[A-Za-z0-9_]*(\?|$)/.test(process.env.DATABASE_URL ?? '')

;(HAS_TEST_DB ? describe : describe.skip)('POST /api/reports through the route', function () {
  this.timeout(30000)

  const MOD = 990201, REPORTER = 990202, AUTHOR = 990203, BYSTANDER = 990204
  const ALL_IDS = [MOD, REPORTER, AUTHOR, BYSTANDER]
  const addr = (n: number) => '0x' + n.toString(16).padStart(40, '0')

  let prisma: typeof import('../../../src/prismaClient').prisma
  let server: Server | undefined
  let baseUrl = ''
  let tokenReporter = ''
  let tokenMod = ''
  let probeToken = ''
  let redisUp = false
  let postId = 0
  let safe = false

  async function cleanup() {
    // 9 is what parseInt reads from the reporter id written as "9.90202e5" in the test below.
    await prisma.report.deleteMany({ where: { reporterId: { in: [...ALL_IDS, 9] } } })
    await prisma.caw.deleteMany({ where: { userId: { in: ALL_IDS } } })
    await prisma.user.deleteMany({ where: { tokenId: { in: ALL_IDS } } })
  }

  async function call(method: string, path: string, token: string, body?: unknown) {
    const res = await (globalThis as any).fetch(baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-session-token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let json: any = null
    try { json = await res.json() } catch { /* no body */ }
    return { status: res.status as number, body: json }
  }

  before(async function () {
    await import('../../helpers/isolatedEnv')
    ;({ prisma } = await import('../../../src/prismaClient'))
    const [{ current_database }] = await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`
    if (!/^caw_test_/.test(current_database)) {
      throw new Error(`refusing to run against database "${current_database}" (expected a caw_test_* database)`)
    }
    safe = true
    const { createSession, addAuthorization } = await import('../../../src/api/sessionStore')
    const probe = await Promise.race([
      createSession().then(({ token }) => { probeToken = token; return 'up' }),
      new Promise<string>(resolve => setTimeout(() => resolve('down'), 3000)),
    ])
    if (probe !== 'up') this.skip() // no Redis behind the sessions
    redisUp = true

    await cleanup()
    await prisma.user.createMany({
      data: [
        { id: MOD, tokenId: MOD, username: 'rp_mod', address: addr(MOD), role: 'MODERATOR' },
        { id: REPORTER, tokenId: REPORTER, username: 'rp_reporter', address: addr(REPORTER) },
        { id: AUTHOR, tokenId: AUTHOR, username: 'rp_author', address: addr(AUTHOR) },
        { id: BYSTANDER, tokenId: BYSTANDER, username: 'rp_bystander', address: addr(BYSTANDER) },
      ] as any,
    })
    const post = await prisma.caw.create({ data: { userId: AUTHOR, content: 'reported post', cawonce: 1, action: 'CAW', status: 'SUCCESS' } as any })
    postId = post.id

    const t1 = await createSession(); await addAuthorization(t1.token, addr(REPORTER), [REPORTER]); tokenReporter = t1.token
    const t2 = await createSession(); await addAuthorization(t2.token, addr(MOD), [MOD]); tokenMod = t2.token

    const express = (await import('express')).default
    const reportsRouter = (await import('../../../src/api/routes/reports')).default
    const app = express()
    app.use(express.json())
    app.use('/api/reports', reportsRouter)
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  })

  after(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    if (safe) await cleanup()
    // The sessions go too, with the index that maps a token id to its sessions:
    // they expire after a year otherwise, and when another test loaded the session
    // store first they are in whichever Redis that one points at.
    // Only when Redis answered: Mocha runs this hook after a skip in `before` too, and
    // with nothing behind the client a command just waits.
    if (redisUp) {
      const { deleteSession, pruneTokenIdFromAllSessions } = await import('../../../src/api/sessionStore')
      for (const token of [probeToken, tokenReporter, tokenMod]) if (token) await deleteSession(token)
      for (const id of ALL_IDS) await pruneTokenIdFromAllSessions(id)
    }
  })

  it('stores the author of the post, not the author named in the body, and does not need one', async () => {
    const named = await call('POST', '/api/reports', tokenReporter, { reporterId: REPORTER, postId, postAuthorId: BYSTANDER, reason: 'SPAM' })
    expect(named.status).to.equal(201)
    const row = await prisma.report.findUnique({ where: { id: named.body.reportId } })
    expect(row!.postAuthorId).to.equal(AUTHOR)
    await prisma.report.delete({ where: { id: named.body.reportId } })

    const none = await call('POST', '/api/reports', tokenReporter, { reporterId: REPORTER, postId, reason: 'SPAM' })
    expect(none.status).to.equal(201)
    expect((await prisma.report.findUnique({ where: { id: none.body.reportId } }))!.postAuthorId).to.equal(AUTHOR)
    await prisma.report.delete({ where: { id: none.body.reportId } })
  })

  it('answers 404 for a post that does not exist', async () => {
    const res = await call('POST', '/api/reports', tokenReporter, { reporterId: REPORTER, postId: 2000000000, postAuthorId: AUTHOR, reason: 'SPAM' })
    expect(res.status).to.equal(404)
    expect(await prisma.report.count({ where: { postId: 2000000000 } })).to.equal(0)
  })

  it('answers 400, not 500, for a post id that is not a number', async () => {
    const res = await call('POST', '/api/reports', tokenReporter, { reporterId: REPORTER, postId: 'abc', postAuthorId: AUTHOR, reason: 'SPAM' })
    expect(res.status).to.equal(400)
  })

  it('files the report as the reporter the session was checked for, however the id is written', async () => {
    // requireAuth reads the id with Number(), so "9.90202e5" is the signed-in reporter, 990202.
    // parseInt would read it as 9 and file the report as somebody else.
    const res = await call('POST', '/api/reports', tokenReporter, { reporterId: '9.90202e5', postId, reason: 'SPAM' })
    expect(res.status).to.equal(201)
    const row = await prisma.report.findUnique({ where: { id: res.body.reportId } })
    expect(row!.reporterId).to.equal(REPORTER)
    expect(await prisma.report.count({ where: { reporterId: 9 } })).to.equal(0)
    await prisma.report.delete({ where: { id: res.body.reportId } })
  })

  it('accepts the reporter id in the query, where requireAuth also looks for it', async () => {
    const res = await call('POST', `/api/reports?reporterId=${REPORTER}`, tokenReporter, { postId, reason: 'SPAM' })
    expect(res.status).to.equal(201)
    const row = await prisma.report.findUnique({ where: { id: res.body.reportId } })
    expect(row!.reporterId).to.equal(REPORTER)
    await prisma.report.delete({ where: { id: res.body.reportId } })
  })

  it('keeps what a moderator decided when the reporter reports the post again', async () => {
    const first = await call('POST', '/api/reports', tokenReporter, { reporterId: REPORTER, postId, reason: 'SPAM', details: 'first' })
    const id = first.body.reportId ?? (await prisma.report.findFirst({ where: { reporterId: REPORTER, postId } }))!.id
    const patched = await call('PATCH', `/api/reports/${id}`, tokenMod, { status: 'DISMISSED', resolution: 'not spam' })
    expect(patched.status).to.equal(200)
    const before = await prisma.report.findUnique({ where: { id } })
    expect(before!.status).to.equal('DISMISSED')

    const again = await call('POST', '/api/reports', tokenReporter, { reporterId: REPORTER, postId, reason: 'HARASSMENT', details: 'second' })
    expect(again.status).to.equal(200)
    const after = await prisma.report.findUnique({ where: { id } })
    expect(after).to.deep.equal(before)
    expect(after!.reviewedBy).to.equal(String(MOD))
    expect(after!.resolution).to.equal('not spam')
  })
})

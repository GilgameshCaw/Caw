/**
 * GET /api/reports (moderator list) returns usernames and a post excerpt next
 * to the raw Report rows. Post content is only returned for SUCCESS posts.
 *
 * Needs a throwaway database; SKIPS unless DATABASE_URL points at caw_test_*.
 * From client/:
 *   DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/caw_test_reportuser \
 *   npx mocha --import=tsx --exit tests/api/routes/reportsAdminList.test.ts
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import type { Server } from 'http'
import type { AddressInfo } from 'net'

const HAS_TEST_DB = /\/caw_test_[A-Za-z0-9_]*(\?|$)/.test(process.env.DATABASE_URL ?? '')

const BASE = 990400
const moderator = { tokenId: BASE, username: 'rc_test_mod', address: '0x' + 'd4'.repeat(20) }
const plain = { tokenId: BASE + 1, username: 'rc_test_plain', address: '0x' + 'e5'.repeat(20) }
const author = { tokenId: BASE + 2, username: 'rc_test_author', address: '0x' + 'f6'.repeat(20) }
const reporter = { tokenId: BASE + 3, username: 'rc_test_reporter', address: '0x' + '17'.repeat(20) }
const zero = { tokenId: 0, username: 'rc_test_zero', address: '0x' + '28'.repeat(20) }
const ALL_IDS = [moderator.tokenId, plain.tokenId, author.tokenId, reporter.tokenId, zero.tokenId]

const LONG = 'x'.repeat(300)
const CAWS = [
  { key: 'ok', content: 'hello report context', status: 'SUCCESS', cawonce: 1 },
  { key: 'long', content: LONG, status: 'SUCCESS', cawonce: 2 },
  { key: 'hidden', content: 'secret removed text', status: 'HIDDEN', cawonce: 3 },
  { key: 'pending', content: 'not confirmed yet', status: 'PENDING', cawonce: 4 },
] as const

;(HAS_TEST_DB ? describe : describe.skip)('GET /api/reports (moderator list)', function () {
  this.timeout(30000)

  let prisma: typeof import('../../../src/prismaClient').prisma
  let server: Server | undefined
  let baseUrl = ''
  let modToken = ''
  let plainToken = ''
  let safe = false
  const postIdByKey: Record<string, number> = {}
  let spoofedPostId = 0
  let rows: any[] = []

  async function get(token?: string) {
    const headers: Record<string, string> = {}
    if (token) headers['x-session-token'] = token
    const res = await (globalThis as any).fetch(baseUrl + '/api/reports?limit=100', { headers })
    return { status: res.status as number, json: await res.json().catch(() => ({})) }
  }

  async function cleanup() {
    await prisma.report.deleteMany({ where: { reporterId: reporter.tokenId } })
    await prisma.caw.deleteMany({ where: { userId: author.tokenId } })
    await prisma.user.deleteMany({ where: { tokenId: { in: ALL_IDS } } })
  }

  before(async () => {
    await import('../../helpers/isolatedEnv')
    ;({ prisma } = await import('../../../src/prismaClient'))
    const { createApp } = await import('../../../src/api/server')
    const { createSession, addAuthorization } = await import('../../../src/api/sessionStore')
    const [{ current_database }] = await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`
    if (!/^caw_test_/.test(current_database)) {
      throw new Error(`refusing to run against database "${current_database}" (expected a caw_test_* database)`)
    }
    safe = true
    await cleanup()

    await prisma.user.createMany({
      data: [plain, author, reporter, zero].map(u => ({ id: u.tokenId, tokenId: u.tokenId, username: u.username, address: u.address })),
    })
    await prisma.user.create({
      data: { id: moderator.tokenId, tokenId: moderator.tokenId, username: moderator.username, address: moderator.address, role: 'MODERATOR' },
    })

    for (const c of CAWS) {
      const row = await prisma.caw.create({
        data: { userId: author.tokenId, content: c.content, action: 'CAW' as const, cawonce: c.cawonce, status: c.status },
      })
      postIdByKey[c.key] = row.id
      await prisma.report.create({
        data: { reporterId: reporter.tokenId, postId: row.id, postAuthorId: author.tokenId, reason: 'SPAM' },
      })
    }
    // a report on a real post filed with the wrong postAuthorId (the API stores
    // whatever the reporter sends)
    const spoofedCaw = await prisma.caw.create({
      data: { userId: author.tokenId, content: 'spoofed author report', action: 'CAW' as const, cawonce: 5, status: 'SUCCESS' },
    })
    spoofedPostId = spoofedCaw.id
    await prisma.report.create({
      data: { reporterId: reporter.tokenId, postId: spoofedCaw.id, postAuthorId: plain.tokenId, reason: 'SPAM' },
    })
    // a user report (postId 0)
    await prisma.report.create({
      data: { reporterId: reporter.tokenId, postId: 0, postAuthorId: author.tokenId, reason: 'HARASSMENT', details: 'Reported user: @x' },
    })

    // a user report against tokenId 0 (a real tokenId, not a sentinel)
    await prisma.report.create({
      data: { reporterId: reporter.tokenId, postId: 0, postAuthorId: zero.tokenId, reason: 'SPAM', details: 'Reported user: @zero' },
    })

    const m = await createSession()
    modToken = m.token
    await addAuthorization(modToken, moderator.address, [moderator.tokenId])
    const p = await createSession()
    plainToken = p.token
    await addAuthorization(plainToken, plain.address, [plain.tokenId])

    await new Promise<void>(resolve => {
      server = createApp().listen(0, '127.0.0.1', () => resolve())
    })
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`

    const r = await get(modToken)
    expect(r.status).to.equal(200)
    rows = (r.json.reports as any[]).filter(x => x.reporterId === reporter.tokenId)
  })

  after(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    const { deleteSession } = await import('../../../src/api/sessionStore')
    if (modToken) await deleteSession(modToken)
    if (plainToken) await deleteSession(plainToken)
    if (safe) await cleanup()
  })

  const byPost = (key: string) => rows.find(x => x.postId === postIdByKey[key])

  it('401 without a session', async () => {
    expect((await get()).status).to.equal(401)
  })

  it('403 for a session that is not a moderator', async () => {
    const r = await get(plainToken)
    expect(r.status).to.equal(403)
    expect(r.json.error).to.equal('NOT_MODERATOR')
  })

  it('returns all seven rows with the original fields intact', () => {
    expect(rows).to.have.length(7)
    expect(byPost('ok').reason).to.equal('SPAM')
    expect(byPost('ok').postAuthorId).to.equal(author.tokenId)
  })

  it('adds usernames and the post content for a SUCCESS post', () => {
    const r = byPost('ok')
    expect(r.reporterIdUsername).to.equal(reporter.username)
    expect(r.postAuthorIdUsername).to.equal(author.username)
    expect(r.postStatus).to.equal('SUCCESS')
    expect(r.postActualAuthorId).to.equal(author.tokenId)
    expect(r.postAuthorMismatch).to.equal(false)
    expect(r.postContent).to.equal('hello report context')
  })

  it('names the post author from the Caw row when the reporter sent a different postAuthorId', () => {
    const r = rows.find(x => x.postId === spoofedPostId)
    expect(r.postAuthorId).to.equal(plain.tokenId)
    expect(r.postActualAuthorId).to.equal(author.tokenId)
    expect(r.postAuthorIdUsername).to.equal(author.username)
    expect(r.postAuthorMismatch).to.equal(true)
  })

  it('cuts long content to 200 characters plus an ellipsis', () => {
    const r = byPost('long')
    expect(r.postContent).to.have.length(203)
    expect(r.postContent.endsWith('...')).to.equal(true)
  })

  it('does not return content for a HIDDEN post', () => {
    const r = byPost('hidden')
    expect(r.postStatus).to.equal('HIDDEN')
    expect(r.postContent).to.equal(null)
  })

  it('does not return content for a PENDING post', () => {
    const r = byPost('pending')
    expect(r.postStatus).to.equal('PENDING')
    expect(r.postContent).to.equal(null)
  })

  it('a user report against tokenId 0 still gets the reported username', () => {
    const r = rows.find(x => x.postAuthorId === zero.tokenId)
    expect(r.postAuthorIdUsername).to.equal(zero.username)
  })

  it('a user report (postId 0) has no post fields but names the reported user', () => {
    const r = rows.find(x => x.postId === 0 && x.postAuthorId === author.tokenId)
    expect(r.postStatus).to.equal(null)
    expect(r.postContent).to.equal(null)
    expect(r.postAuthorIdUsername).to.equal(author.username)
  })
})

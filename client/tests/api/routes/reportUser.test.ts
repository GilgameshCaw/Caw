/**
 * POST /api/reports/user (report a user from a DM).
 *
 * The route is requireAuth({ field: 'reporterId', verifyOwnership: true }):
 * the reporter's tokenId must be in the request BODY, and `reason` must be a
 * value of the Prisma ReportReason enum. This pins that contract, which the
 * report-user modal has to satisfy.
 *
 * Needs a throwaway database; SKIPS unless DATABASE_URL points at caw_test_*.
 * From client/:
 *   DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/caw_test_reportuser \
 *   npx mocha --import=tsx --exit tests/api/routes/reportUser.test.ts
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import type { Server } from 'http'
import type { AddressInfo } from 'net'

const HAS_TEST_DB = /\/caw_test_[A-Za-z0-9_]*(\?|$)/.test(process.env.DATABASE_URL ?? '')

const BASE = 990300
const reporter = { tokenId: BASE, username: 'ru_test_reporter', address: '0x' + 'a1'.repeat(20) }
const target = { tokenId: BASE + 1, username: 'ru_test_target', address: '0x' + 'b2'.repeat(20) }
const stranger = { tokenId: BASE + 2, username: 'ru_test_stranger', address: '0x' + 'c3'.repeat(20) }
const ALL_IDS = [reporter.tokenId, target.tokenId, stranger.tokenId]

;(HAS_TEST_DB ? describe : describe.skip)('POST /api/reports/user', function () {
  this.timeout(30000)

  let prisma: typeof import('../../../src/prismaClient').prisma
  let server: Server | undefined
  let baseUrl = ''
  let token = ''
  let safe = false

  async function post(body: Record<string, unknown>) {
    const res = await (globalThis as any).fetch(baseUrl + '/api/reports/user', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': token },
      body: JSON.stringify(body),
    })
    return { status: res.status as number, json: await res.json().catch(() => ({})) }
  }

  async function cleanup() {
    await prisma.report.deleteMany({ where: { reporterId: { in: ALL_IDS } } })
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
      data: [reporter, target, stranger].map(u => ({ id: u.tokenId, tokenId: u.tokenId, username: u.username, address: u.address })),
    })
    const created = await createSession()
    token = created.token
    await addAuthorization(token, reporter.address, [reporter.tokenId])

    await new Promise<void>(resolve => {
      server = createApp().listen(0, '127.0.0.1', () => resolve())
    })
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  })

  after(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    if (token) {
      const { deleteSession } = await import('../../../src/api/sessionStore')
      await deleteSession(token)
    }
    if (safe) await cleanup()
  })

  it('400 MISSING_TOKEN_ID when the body has no reporterId (what the old modal sent)', async () => {
    const r = await post({ reportedUserId: target.tokenId, reportedUsername: target.username, reason: 'SPAM' })
    expect(r.status).to.equal(400)
    expect(r.json.error).to.equal('MISSING_TOKEN_ID')
  })

  it('400 Invalid reason for SCAM (not in the ReportReason enum)', async () => {
    const r = await post({ reporterId: reporter.tokenId, reportedUserId: target.tokenId, reason: 'SCAM' })
    expect(r.status).to.equal(400)
    expect(r.json.error).to.equal('Invalid reason')
  })

  it('401 TOKEN_NOT_AUTHORIZED for a reporterId the session does not own', async () => {
    const r = await post({ reporterId: stranger.tokenId, reportedUserId: target.tokenId, reason: 'SPAM' })
    expect(r.status).to.equal(401)
    expect(r.json.error).to.equal('TOKEN_NOT_AUTHORIZED')
  })

  it('201 and a stored report for reporterId + a valid reason', async () => {
    const r = await post({ reporterId: reporter.tokenId, reportedUserId: target.tokenId, reportedUsername: target.username, reason: 'HARASSMENT', details: 'x' })
    expect(r.status).to.equal(201)
    const row = await prisma.report.findUnique({ where: { id: r.json.reportId } })
    expect(row?.reporterId).to.equal(reporter.tokenId)
    expect(row?.postAuthorId).to.equal(target.tokenId)
    expect(row?.postId).to.equal(0)
    expect(row?.reason).to.equal('HARASSMENT')
  })

  it('409 when the same user is reported again', async () => {
    const r = await post({ reporterId: reporter.tokenId, reportedUserId: target.tokenId, reason: 'SPAM' })
    expect(r.status).to.equal(409)
  })
})

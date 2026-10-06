/**
 * GET /api/admin/db/:model[/:id] for models whose primary key is not `id`
 * (sponsorCode -> codeHash, sponsorRepay -> tokenId).
 *
 * Needs a throwaway database; SKIPS unless DATABASE_URL points at caw_test_*.
 * From client/:
 *   DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/caw_test_reportuser \
 *   npx mocha --import=tsx --exit tests/api/routes/adminDbDetail.test.ts
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import type { Server } from 'http'
import type { AddressInfo } from 'net'

const HAS_TEST_DB = /\/caw_test_[A-Za-z0-9_]*(\?|$)/.test(process.env.DATABASE_URL ?? '')

const BASE = 990500
const admin = { tokenId: BASE, username: 'ad_test_admin', address: '0x' + '39'.repeat(20) }
const CODE_HASH = 'ad_test_codehash_' + 'ab'.repeat(8)
const REPAY_TOKEN_ID = BASE + 1

;(HAS_TEST_DB ? describe : describe.skip)('GET /api/admin/db (models with a non-id primary key)', function () {
  this.timeout(30000)

  let prisma: typeof import('../../../src/prismaClient').prisma
  let server: Server | undefined
  let baseUrl = ''
  let token = ''
  let safe = false

  async function get(path: string) {
    const res = await (globalThis as any).fetch(baseUrl + path, { headers: { 'x-session-token': token } })
    return { status: res.status as number, json: await res.json().catch(() => ({})) }
  }

  async function send(method: string, path: string, body: Record<string, unknown>) {
    const res = await (globalThis as any).fetch(baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-session-token': token },
      body: JSON.stringify(body),
    })
    return { status: res.status as number, json: await res.json().catch(() => ({})) }
  }

  async function cleanup() {
    await prisma.sponsorRepay.deleteMany({ where: { tokenId: REPAY_TOKEN_ID } })
    await prisma.sponsorCode.deleteMany({ where: { codeHash: CODE_HASH } })
    await prisma.user.deleteMany({ where: { tokenId: admin.tokenId } })
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

    await prisma.user.create({
      data: { id: admin.tokenId, tokenId: admin.tokenId, username: admin.username, address: admin.address, role: 'ADMIN' },
    })
    await prisma.sponsorCode.create({
      data: {
        codeHash: CODE_HASH,
        tier: 'test',
        budgetCapUsdCents: 0,
        maxDepositCawWei: '0',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    })
    await prisma.sponsorRepay.create({
      data: {
        tokenId: REPAY_TOKEN_ID,
        sponsorTokenId: BASE + 2,
        originalRepayAmount: '1',
        currentRepayAmount: '1',
      },
    })

    const created = await createSession()
    token = created.token
    await addAuthorization(token, admin.address, [admin.tokenId])

    await new Promise<void>(resolve => {
      server = createApp().listen(0, '127.0.0.1', () => resolve())
    })
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  })

  after(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    const { deleteSession } = await import('../../../src/api/sessionStore')
    if (token) await deleteSession(token)
    if (safe) await cleanup()
  })

  it('control: a model keyed by id still opens by its numeric id', async () => {
    const r = await get(`/api/admin/db/user/${admin.tokenId}`)
    expect(r.status).to.equal(200)
    expect(r.json.record.tokenId).to.equal(admin.tokenId)
  })

  it('sponsorCode: the list rows carry the codeHash the page needs as the id', async () => {
    const r = await get('/api/admin/db/sponsorCode?limit=100')
    expect(r.status).to.equal(200)
    expect(r.json.records.map((x: any) => x.codeHash)).to.include(CODE_HASH)
  })

  it('sponsorRepay: the list rows carry the tokenId the page needs as the id', async () => {
    const r = await get('/api/admin/db/sponsorRepay?limit=100')
    expect(r.status).to.equal(200)
    expect(r.json.records.map((x: any) => x.tokenId)).to.include(REPAY_TOKEN_ID)
  })

  it('sponsorCode: detail opens by codeHash', async () => {
    const r = await get(`/api/admin/db/sponsorCode/${CODE_HASH}`)
    expect(r.status).to.equal(200)
    expect(r.json.record.codeHash).to.equal(CODE_HASH)
  })

  it('sponsorRepay: detail opens by tokenId', async () => {
    const r = await get(`/api/admin/db/sponsorRepay/${REPAY_TOKEN_ID}`)
    expect(r.status).to.equal(200)
    expect(r.json.record.tokenId).to.equal(REPAY_TOKEN_ID)
  })

  it('sponsorCode: the literal "undefined" (what the page sent for these models) is a 404', async () => {
    const r = await get('/api/admin/db/sponsorCode/undefined')
    expect(r.status).to.equal(404)
  })

  it('sponsorRepay: PATCH is still rejected as read-only now that its id resolves', async () => {
    const r = await send('PATCH', `/api/admin/db/sponsorRepay/${REPAY_TOKEN_ID}`, { currentRepayAmount: '2', reason: 'test' })
    expect(r.status).to.equal(403)
    const row = await prisma.sponsorRepay.findUnique({ where: { tokenId: REPAY_TOKEN_ID } })
    expect(row?.currentRepayAmount).to.equal('1')
  })

  it('sponsorRepay: DELETE is still rejected as read-only now that its id resolves', async () => {
    const r = await send('DELETE', `/api/admin/db/sponsorRepay/${REPAY_TOKEN_ID}`, { reason: 'test' })
    expect(r.status).to.equal(403)
    const row = await prisma.sponsorRepay.findUnique({ where: { tokenId: REPAY_TOKEN_ID } })
    expect(row).to.not.equal(null)
  })
})

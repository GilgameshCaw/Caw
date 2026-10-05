/**
 * PATCH /api/admin/db/:model/:id — where the admin's own reason travels.
 *
 * user, txQueue and withdrawalRequest need a reason (it goes into the
 * ModeratorAction audit row). The admin page sends it as `auditReason`: txQueue
 * has a `reason` column of its own, and a `reason` key is written into it.
 *
 * Goes through the real HTTP routes with an admin session, so it needs a
 * throwaway database. It SKIPS unless DATABASE_URL points at a caw_test_*
 * database. Example (from client/):
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/caw_test_admindb \
 *   npx mocha --import=tsx --exit tests/api/routes/adminDbPatchReason.test.ts
 *
 * The app is imported lazily inside `before`, after ../../helpers/isolatedEnv,
 * like the other route tests.
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import type { Server } from 'http'
import type { AddressInfo } from 'net'

const HAS_TEST_DB = /\/caw_test_[A-Za-z0-9_]*(\?|$)/.test(process.env.DATABASE_URL ?? '')

const BASE = 990300
const ADMIN = { tokenId: BASE, username: 'adb_test_admin' }
const TARGET = { tokenId: BASE + 1, username: 'adb_test_target' }
const ADMIN_ADDRESS = '0x' + '0'.repeat(39) + '1'
const QUEUE_MARK = '0xadmindbtest'
const ORIGINAL = 'original failure reason'
const SETTING_KEY = 'adb_test_setting'

;(HAS_TEST_DB ? describe : describe.skip)('admin DB PATCH: where the audit reason goes', function () {
  this.timeout(30000)

  let prisma: typeof import('../../../src/prismaClient').prisma
  let createApp: typeof import('../../../src/api/server').createApp
  let sessionStore: typeof import('../../../src/api/sessionStore') | undefined
  let server: Server | undefined
  let baseUrl = ''
  let sessionToken = ''
  let safe = false

  async function call(method: string, path: string, body?: Record<string, unknown>) {
    const res = await (globalThis as any).fetch(baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: res.status as number, json: (await res.json().catch(() => ({}))) as any }
  }
  const patch = (model: string, id: number, body: Record<string, unknown>) =>
    call('PATCH', `/api/admin/db/${model}/${id}`, body)

  const newQueueRow = () =>
    prisma.txQueue.create({
      data: { payload: {}, signedTx: QUEUE_MARK, senderId: TARGET.tokenId, status: 'failed', reason: ORIGINAL },
    })
  const queueRow = (id: number) => prisma.txQueue.findUniqueOrThrow({ where: { id } })
  async function auditReasons(type: string) {
    const rows = await prisma.moderatorAction.findMany({ where: { type, actorTokenId: ADMIN.tokenId } })
    return rows.map(r => r.reason)
  }

  async function cleanup() {
    await prisma.moderatorAction.deleteMany({ where: { actorTokenId: ADMIN.tokenId } })
    await prisma.txQueue.deleteMany({ where: { signedTx: QUEUE_MARK } })
    await prisma.validatorSetting.deleteMany({ where: { key: SETTING_KEY } })
    await prisma.user.deleteMany({ where: { tokenId: { in: [ADMIN.tokenId, TARGET.tokenId] } } })
  }

  before(async () => {
    await import('../../helpers/isolatedEnv')
    ;({ prisma } = await import('../../../src/prismaClient'))
    ;({ createApp } = await import('../../../src/api/server'))
    const sessions = await import('../../../src/api/sessionStore')
    sessionStore = sessions
    const [{ current_database }] = await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`
    if (!/^caw_test_/.test(current_database)) {
      throw new Error(`refusing to run against database "${current_database}" (expected a caw_test_* database)`)
    }
    safe = true
    await cleanup()

    await prisma.user.create({ data: { id: ADMIN.tokenId, tokenId: ADMIN.tokenId, username: ADMIN.username, role: 'ADMIN' } })
    await prisma.user.create({ data: { id: TARGET.tokenId, tokenId: TARGET.tokenId, username: TARGET.username } })
    const { token } = await sessions.createSession()
    await sessions.addAuthorization(token, ADMIN_ADDRESS, [ADMIN.tokenId])
    sessionToken = token

    await new Promise<void>(resolve => {
      server = createApp().listen(0, '127.0.0.1', () => resolve())
    })
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  })

  after(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    if (sessionStore) {
      await sessionStore.pruneTokenIdFromAllSessions(ADMIN.tokenId).catch(() => {})
      await sessionStore.deleteSession(sessionToken).catch(() => {})
    }
    if (safe) await cleanup()
  })

  it('txQueue: auditReason is recorded and the reason column is left alone', async () => {
    const { id } = await newQueueRow()
    const r = await patch('txQueue', id, { status: 'dismissed', auditReason: 'cleanup of test row' })
    expect(r.status, JSON.stringify(r.json)).to.equal(200)
    const row = await queueRow(id)
    expect(row.status).to.equal('dismissed')
    expect(row.reason).to.equal(ORIGINAL)
    expect(await auditReasons('admin_db_patch:txQueue')).to.include(`Updated txQueue/${id}: cleanup of test row`)
  })

  it('txQueue: editing the reason column works and is not the audit reason', async () => {
    const { id } = await newQueueRow()
    const r = await patch('txQueue', id, { reason: 'edited failure reason', auditReason: 'fixing the failure text' })
    expect(r.status, JSON.stringify(r.json)).to.equal(200)
    expect((await queueRow(id)).reason).to.equal('edited failure reason')
    expect(await auditReasons('admin_db_patch:txQueue')).to.include(`Updated txQueue/${id}: fixing the failure text`)
  })

  it('txQueue: a reason key alone is not an audit reason, and the column is not touched', async () => {
    const { id } = await newQueueRow()
    const r = await patch('txQueue', id, { reason: 'only the column' })
    expect(r.status).to.equal(400)
    expect(r.json.error).to.contain('auditReason')
    expect((await queueRow(id)).reason).to.equal(ORIGINAL)
  })

  it('txQueue: no reason at all is rejected and nothing changes', async () => {
    const { id } = await newQueueRow()
    const r = await patch('txQueue', id, { status: 'dismissed' })
    expect(r.status).to.equal(400)
    expect((await queueRow(id)).status).to.equal('failed')
  })

  it('user: a legacy reason key still works as the audit reason', async () => {
    const r = await patch('user', TARGET.tokenId, { username: 'adb_test_renamed', reason: 'legacy caller' })
    expect(r.status, JSON.stringify(r.json)).to.equal(200)
    const u = await prisma.user.findUniqueOrThrow({ where: { tokenId: TARGET.tokenId } })
    expect(u.username).to.equal('adb_test_renamed')
    expect(await auditReasons('admin_db_patch:user')).to.include(`Updated user/${TARGET.tokenId}: legacy caller`)
  })

  it('user: auditReason works too', async () => {
    const r = await patch('user', TARGET.tokenId, { username: 'adb_test_renamed2', auditReason: 'new caller' })
    expect(r.status, JSON.stringify(r.json)).to.equal(200)
    expect(await auditReasons('admin_db_patch:user')).to.include(`Updated user/${TARGET.tokenId}: new caller`)
  })

  it('user: no reason is rejected and nothing changes', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { tokenId: TARGET.tokenId } })
    const r = await patch('user', TARGET.tokenId, { username: 'adb_test_nope' })
    expect(r.status).to.equal(400)
    expect(r.json.error).to.equal('reason field is required for admin PATCH on user')
    const after = await prisma.user.findUniqueOrThrow({ where: { tokenId: TARGET.tokenId } })
    expect(after.username).to.equal(before.username)
  })

  it('a model that does not need a reason still saves without one', async () => {
    await prisma.validatorSetting.create({ data: { key: SETTING_KEY, value: 'a' } })
    const r = await call('PATCH', `/api/admin/db/validatorSetting/${SETTING_KEY}`, { value: 'b' })
    expect(r.status, JSON.stringify(r.json)).to.equal(200)
    expect((await prisma.validatorSetting.findUniqueOrThrow({ where: { key: SETTING_KEY } })).value).to.equal('b')
  })

  it('withdrawalRequest: a reason is required too', async () => {
    const r = await patch('withdrawalRequest', 999999999, { status: 'cancelled' })
    expect(r.status).to.equal(400)
    expect(r.json.error).to.equal('reason field is required for admin PATCH on withdrawalRequest')
  })

  it('user: an empty auditReason falls back to a legacy reason', async () => {
    const r = await patch('user', TARGET.tokenId, { username: 'adb_test_renamed3', auditReason: '  ', reason: 'legacy with empty audit' })
    expect(r.status, JSON.stringify(r.json)).to.equal(200)
    expect(await auditReasons('admin_db_patch:user')).to.include(`Updated user/${TARGET.tokenId}: legacy with empty audit`)
  })

  it('GET /models flags exactly the models whose PATCH needs a reason', async () => {
    const r = await call('GET', '/api/admin/db/models')
    expect(r.status).to.equal(200)
    const flagged = r.json.models.filter((m: any) => m.requiresReason).map((m: any) => m.name).sort()
    expect(flagged).to.deep.equal(['txQueue', 'user', 'withdrawalRequest'])
  })
})

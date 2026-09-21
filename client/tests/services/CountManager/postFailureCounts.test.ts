// Counters across a caw's failure and later confirmation: what the failure paths
// take off, the FAILED -> SUCCESS transition has to put back, and only one path
// may roll a row back. Runs the real CountManager, txQueueFailure, DataCleaner
// sweep and handleRecawAction against a database.
//
// The tests write rows, so they only run against a throwaway database whose name
// starts with "caw_test_" (a schema-only copy: pg_dump -s). Anywhere else they are
// skipped.
//
//   createdb caw_test_countrollback   # then load the schema only
//   NETWORK_ID=1 CLIENT_ID=1 DATABASE_URL='postgresql://.../caw_test_countrollback' \
//     REDIS_URL=redis://127.0.0.1:1 ELASTICSEARCH_NODE=http://127.0.0.1:1 ES_INDEX_PREFIX=caw_test_countrollback \
//     npx mocha --import=tsx --exit tests/services/CountManager/postFailureCounts.test.ts
//
// Importing these modules creates a Redis client (orphanedMedia) and an
// Elasticsearch client (ElasticsearchService) at import time, and a reachable
// Elasticsearch would be filled from the database. The three variables above point
// both at an unused port (and a private index prefix) so this test never reaches a
// real Redis or Elasticsearch. Expect connection-refused log lines.

import { expect } from 'chai'

const dbName = (process.env.DATABASE_URL || '').split('?')[0].split('/').pop() || ''
const describeDb = dbName.startsWith('caw_test_') ? describe : describe.skip

const AUTHOR = 92001 // author of the parent caw
const USER = 92002 // the user whose counters are checked
const OTHER = 92003 // author of the parent's other children
const IDS = [AUTHOR, USER, OTHER]

let prisma: any
let countManager: any
let markTxQueueFailed: any
let cleanupPendingCaws: any
let handleRecawAction: any
let NotificationService: any
let PrismaClientCtor: any
const realNotifications: Record<string, any> = {}

async function loadModules(): Promise<void> {
  // The modules read their environment at import time.
  process.env.NETWORK_ID = process.env.NETWORK_ID || '1'
  process.env.CLIENT_ID = process.env.CLIENT_ID || '1'
  prisma = (await import('../../../src/prismaClient')).prisma
  countManager = (await import('../../../src/services/CountManager')).countManager
  markTxQueueFailed = (await import('../../../src/utils/txQueueFailure')).markTxQueueFailed
  cleanupPendingCaws = (await import('../../../src/services/DataCleaner')).cleanupPendingCaws
  handleRecawAction = (await import('../../../src/services/ActionProcessor/actionHandlers')).handleRecawAction
  NotificationService = (await import('../../../src/services/NotificationService')).NotificationService
  PrismaClientCtor = (await import('@prisma/client')).PrismaClient
}

let nextCawonce = 1000
const cawonce = () => nextCawonce++

async function resetFixtures(): Promise<void> {
  await prisma.reply.deleteMany({ where: { userId: { in: IDS } } })
  await prisma.txQueue.deleteMany({ where: { senderId: { in: IDS } } })
  await prisma.action.deleteMany({ where: { senderId: { in: IDS } } })
  await prisma.caw.deleteMany({ where: { userId: { in: IDS }, originalCawId: { not: null } } })
  await prisma.caw.deleteMany({ where: { userId: { in: IDS } } })
  await prisma.user.deleteMany({ where: { id: { in: IDS } } })
  for (const id of IDS) await prisma.user.create({ data: { id, tokenId: id, username: `cbtest${id}` } })
  await prisma.user.update({ where: { tokenId: USER }, data: { cawCount: 5, recawCount: 3 } })
}

type Child = { action: 'RECAW' | 'CAW'; text: string }

/** A parent caw with two confirmed plain RECAWs (and optionally more children), recawCount kept consistent. */
async function seedParent(extra: Child[] = []) {
  const parent = await prisma.caw.create({ data: { userId: AUTHOR, content: 'parent', action: 'CAW', cawonce: cawonce() } })
  const children: Child[] = [{ action: 'RECAW', text: '' }, { action: 'RECAW', text: '' }, ...extra]
  for (const c of children) {
    await prisma.caw.create({
      data: { userId: OTHER, content: c.text, action: c.action, cawonce: cawonce(), originalCawId: parent.id, status: 'SUCCESS' },
    })
  }
  await prisma.caw.update({ where: { id: parent.id }, data: { recawCount: children.length } })
  return parent
}

type Kind = 'post' | 'recaw' | 'quoteRecaw' | 'quoteCaw' | 'reply'
const SHAPE: Record<Kind, { action: 'CAW' | 'RECAW'; text: string; hasParent: boolean; isReply: boolean; actionType: number }> = {
  post: { action: 'CAW', text: 'hello', hasParent: false, isReply: false, actionType: 0 },
  recaw: { action: 'RECAW', text: '', hasParent: true, isReply: false, actionType: 3 },
  quoteRecaw: { action: 'RECAW', text: 'my take', hasParent: true, isReply: false, actionType: 3 }, // a quote stored as RECAW + text
  quoteCaw: { action: 'CAW', text: 'my take', hasParent: true, isReply: false, actionType: 0 }, // a quote stored as CAW
  reply: { action: 'CAW', text: 'a reply', hasParent: true, isReply: true, actionType: 0 },
}

/** What the submit path does: a PENDING row, plus the optimistic count bump (nothing extra for a reply). */
async function submit(kind: Kind, parentId: number | null, createdAt?: Date, bump = true) {
  const s = SHAPE[kind]
  const cn = cawonce()
  const caw = await prisma.caw.create({
    data: {
      userId: USER,
      cawonce: cn,
      content: s.text,
      action: s.action,
      status: 'PENDING',
      originalCawId: s.hasParent ? parentId : null,
      ...(createdAt ? { createdAt } : {}),
    },
  })
  if (s.isReply) await prisma.reply.create({ data: { userId: USER, cawId: parentId!, replyCawId: caw.id, pending: true } })
  if (bump) {
    await countManager.onCawCreated(prisma, {
      id: caw.id,
      userId: USER,
      action: s.action,
      originalCawId: s.isReply ? null : s.hasParent ? parentId : null,
      status: 'PENDING',
      isReply: s.isReply,
    })
  }
  return { caw, cawonce: cn, ...s }
}
type Submitted = Awaited<ReturnType<typeof submit>>

/** The validator's failure path for the row's tx. The reason makes it return before any notification is written. */
async function failByValidator(sub: Submitted): Promise<void> {
  const q = await prisma.txQueue.create({
    data: { payload: { data: { actionType: sub.actionType, cawonce: sub.cawonce } }, signedTx: '0x', status: 'pending', senderId: USER, cawonce: sub.cawonce },
  })
  await markTxQueueFailed(prisma, q.id, 'Cawonce already used', USER, { actionType: sub.actionType, cawonce: sub.cawonce })
}

/** The indexer confirming a RECAW / quote action on chain. */
const confirmRecaw = (sub: Submitted, parentId: number) =>
  prisma.$transaction(async (tx: any) => {
    await handleRecawAction(tx, { senderId: USER, cawonce: sub.cawonce, actionType: 'RECAW' }, { text: sub.text }, parentId)
  })

async function counters(parentId?: number) {
  const u = await prisma.user.findUnique({ where: { tokenId: USER } })
  const p = parentId ? await prisma.caw.findUnique({ where: { id: parentId } }) : null
  return { cawCount: u.cawCount, recawCount: u.recawCount, parentRecaw: p ? p.recawCount : null }
}

const STALE = () => new Date(Date.now() - 40 * 60 * 1000)

describeDb('caw counters across failure and confirmation (disposable database)', function () {
  // Loading the modules (DataCleaner and the handlers pull in a lot) takes several
  // seconds, well past mocha's 2 s default.
  this.timeout(60000)
  before(async () => {
    await loadModules()
    const [{ db }] = await prisma.$queryRaw`SELECT current_database() AS db`
    if (!String(db).startsWith('caw_test_')) throw new Error(`refusing to run against database "${db}"`)
    // Keep notifications out of the test; they are not what is being checked.
    for (const name of ['createRepostNotification', 'createQuoteNotification']) {
      realNotifications[name] = NotificationService[name]
      NotificationService[name] = async () => {}
    }
  })
  after(async () => {
    for (const [name, fn] of Object.entries(realNotifications)) NotificationService[name] = fn
    if (prisma) await resetFixtures().catch(() => {})
  })
  beforeEach(resetFixtures)

  it('a caw confirmed without ever failing keeps the optimistic counts (regression guard)', async () => {
    const parent = await seedParent()
    const sub = await submit('recaw', parent.id)
    await confirmRecaw(sub, parent.id)
    expect(await counters(parent.id)).to.deep.equal({ cawCount: 5, recawCount: 4, parentRecaw: 3 })
  })

  describe('failure, then confirmation on chain (real handler)', () => {
    it('RECAW failed by the validator and confirmed later is counted once', async () => {
      const parent = await seedParent()
      const before = await counters(parent.id)
      const sub = await submit('recaw', parent.id)
      expect(await counters(parent.id)).to.deep.equal({ cawCount: 5, recawCount: 4, parentRecaw: 3 })
      await failByValidator(sub)
      expect(await counters(parent.id)).to.deep.equal(before)
      await confirmRecaw(sub, parent.id)
      expect(await counters(parent.id)).to.deep.equal({ cawCount: 5, recawCount: 4, parentRecaw: 3 })
    })

    it('a quote stored as RECAW + text is put back on the same counter it was taken from', async () => {
      const parent = await seedParent()
      const before = await counters(parent.id)
      const sub = await submit('quoteRecaw', parent.id)
      await failByValidator(sub)
      expect(await counters(parent.id)).to.deep.equal(before)
      await confirmRecaw(sub, parent.id)
      expect(await counters(parent.id)).to.deep.equal({ cawCount: 5, recawCount: 4, parentRecaw: 3 })
    })

    it('RECAW swept to FAILED by DataCleaner and confirmed later is counted once', async () => {
      const parent = await seedParent()
      const before = await counters(parent.id)
      const sub = await submit('recaw', parent.id, STALE())
      await cleanupPendingCaws()
      expect(await prisma.caw.findUnique({ where: { id: sub.caw.id } })).to.include({ status: 'FAILED' })
      expect(await counters(parent.id)).to.deep.equal(before)
      await confirmRecaw(sub, parent.id)
      expect(await counters(parent.id)).to.deep.equal({ cawCount: 5, recawCount: 4, parentRecaw: 3 })
    })

    it('a row marked FAILED because its optimistic increment failed is counted when it confirms', async () => {
      const parent = await seedParent()
      const sub = await submit('recaw', parent.id, undefined, false) // the increment never landed
      await prisma.caw.update({ where: { id: sub.caw.id }, data: { status: 'FAILED' } }) // the submit path's fallback
      expect(await counters(parent.id)).to.deep.equal({ cawCount: 5, recawCount: 3, parentRecaw: 2 })
      await confirmRecaw(sub, parent.id)
      expect(await counters(parent.id)).to.deep.equal({ cawCount: 5, recawCount: 4, parentRecaw: 3 })
    })
  })

  describe('CAW-type rows (CountManager transitions)', () => {
    it('a post: PENDING -> FAILED -> SUCCESS nets to zero', async () => {
      const sub = await submit('post', null)
      expect((await counters()).cawCount).to.equal(6)
      await failByValidator(sub)
      expect((await counters()).cawCount).to.equal(5)
      await countManager.onStatusChanged(prisma, 'caw', sub.caw.id, 'FAILED', 'SUCCESS', {
        userId: USER, action: 'CAW', originalCawId: null, isReply: false,
      })
      expect((await counters()).cawCount).to.equal(6)
    })

    it('a quote stored as CAW: the user counter and the parent both come back', async () => {
      const parent = await seedParent()
      const sub = await submit('quoteCaw', parent.id)
      expect(await counters(parent.id)).to.deep.equal({ cawCount: 6, recawCount: 3, parentRecaw: 3 })
      await failByValidator(sub)
      expect(await counters(parent.id)).to.deep.equal({ cawCount: 5, recawCount: 3, parentRecaw: 2 })
      await prisma.caw.update({ where: { id: sub.caw.id }, data: { status: 'SUCCESS' } }) // what the handler's upsert does
      await countManager.onStatusChanged(prisma, 'caw', sub.caw.id, 'FAILED', 'SUCCESS', {
        userId: USER, action: 'CAW', originalCawId: parent.id, isReply: false,
      })
      await countManager.recomputeParentRecawCount(prisma, parent.id)
      expect(await counters(parent.id)).to.deep.equal({ cawCount: 6, recawCount: 3, parentRecaw: 3 })
    })

    it('a reply never touches user.cawCount: not when submitted, not when failed, not when confirmed', async () => {
      const parent = await seedParent()
      const sub = await submit('reply', parent.id)
      expect((await counters(parent.id)).cawCount).to.equal(5) // the submit path skips the bump for a reply
      await failByValidator(sub)
      expect((await counters(parent.id)).cawCount).to.equal(5)
      await countManager.onStatusChanged(prisma, 'caw', sub.caw.id, 'FAILED', 'SUCCESS', {
        userId: USER, action: 'CAW', originalCawId: null, isReply: true,
      })
      expect((await counters(parent.id)).cawCount).to.equal(5)
    })

    it('a reply swept to FAILED by DataCleaner does not lower user.cawCount either', async () => {
      const parent = await seedParent()
      await submit('reply', parent.id, STALE())
      await cleanupPendingCaws()
      expect(await counters(parent.id)).to.deep.equal({ cawCount: 5, recawCount: 3, parentRecaw: 2 })
    })
  })

  describe('only one path rolls a row back', () => {
    it('DataCleaner does not roll back a row the validator path already failed and rolled back', async function () {
      this.timeout(30000)
      // The user has two posts counted: this pending one and another one.
      await prisma.user.update({ where: { tokenId: USER }, data: { cawCount: 2 } })
      const sub = await submit('post', null, STALE(), false)

      let sweep: Promise<void> | null = null
      // The row lock is held through a second client with its own connection pool, so the
      // sweep, which uses the shared client, cannot compete with it for a connection.
      const locker = new PrismaClientCtor()
      await locker.$transaction(
        async (tx: any) => {
          // Hold the row lock, then let DataCleaner read the row (still PENDING) and reach its update.
          await tx.$queryRaw`SELECT id FROM "Caw" WHERE id = ${sub.caw.id} FOR UPDATE`
          const running: Promise<void> = cleanupPendingCaws()
          sweep = running
          let sweepSettled = false
          running.then(() => { sweepSettled = true }, () => { sweepSettled = true })
          let blocked = false
          for (let i = 0; i < 300 && !blocked && !sweepSettled; i++) {
            const [{ n }] = await tx.$queryRaw`
              SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`
            blocked = n > 0
            if (!blocked) await new Promise((r) => setTimeout(r, 50))
          }
          if (!blocked) {
            const activity = await tx.$queryRaw`
              SELECT pid, state, wait_event_type, wait_event, left(query, 160) AS query FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()`
            throw new Error(`DataCleaner's update never waited on the row lock (sweep settled: ${sweepSettled}); sessions: ${JSON.stringify(activity)}`)
          }
          // Meanwhile the validator path fails the row and rolls it back.
          await tx.$executeRaw`UPDATE "Caw" SET "status" = 'FAILED' WHERE "id" = ${sub.caw.id}`
          await tx.$executeRaw`UPDATE "User" SET "cawCount" = GREATEST(0, "cawCount" - 1) WHERE "tokenId" = ${USER}`
        },
        { timeout: 30000, maxWait: 10000 },
      ).finally(() => locker.$disconnect())
      await sweep
      expect((await counters()).cawCount).to.equal(1) // rolled back once, not twice
    })
  })

  describe("parent's recawCount", () => {
    it('is recomputed from RECAWs and quotes, without replies or failed children', async () => {
      const parent = await seedParent([{ action: 'RECAW', text: 'quote as recaw' }, { action: 'CAW', text: 'quote as caw' }])
      const reply = await prisma.caw.create({
        data: { userId: OTHER, content: 'a reply', action: 'CAW', cawonce: cawonce(), originalCawId: parent.id, status: 'SUCCESS' },
      })
      await prisma.reply.create({ data: { userId: OTHER, cawId: parent.id, replyCawId: reply.id, pending: false } })
      await prisma.caw.create({
        data: { userId: OTHER, content: '', action: 'RECAW', cawonce: cawonce(), originalCawId: parent.id, status: 'FAILED' },
      })
      await prisma.caw.update({ where: { id: parent.id }, data: { recawCount: 99 } })
      expect(await countManager.recomputeParentRecawCount(prisma, parent.id)).to.equal(4) // 2 RECAW + 2 quotes
      expect((await counters(parent.id)).parentRecaw).to.equal(4)
    })

    it('a plain RECAW confirmed after FAILED does not drop the quotes on the same parent', async () => {
      const parent = await seedParent([{ action: 'CAW', text: 'quote as caw' }]) // 2 RECAWs + 1 quote = 3
      const sub = await submit('recaw', parent.id) // 4
      await failByValidator(sub) // back to 3
      await confirmRecaw(sub, parent.id)
      expect((await counters(parent.id)).parentRecaw).to.equal(4)
    })
  })
})

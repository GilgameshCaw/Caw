// The parent's commentCount after a stale failed reply is swept.
//
// A reply counts in the parent's commentCount from the moment its pending Reply
// row is created, and confirming it adds nothing (scripts/reconcile-caw-counts.ts:
// commentCount = count of Reply rows, pending ones included). The stale-reply
// sweeps in DataCleaner recounted only the rows with pending = false after
// deleting a stale one, so any other pending reply under the same parent fell
// out of the count and was not added back when it confirmed.
//
// The sweeps now take the deleted row's +1 back off the parent (a relative
// change) instead of recounting. A recount also double-counts a reply whose row
// is committed but whose +1 has not run yet; see "a reply whose row is committed
// before its +1".
//
// Integration-style against a real database: the failure goes through the real
// markTxQueueFailed, the optimistic rows are written with the real CountManager,
// and the sweeps are DataCleaner's own. Needs DATABASE_URL pointing at a
// disposable database whose name contains "caw_test_", and ELASTICSEARCH_NODE
// set to an unreachable address (importing DataCleaner starts an Elasticsearch
// sync); the guards run in before(), ahead of the dynamic imports.

process.env.CLIENT_ID = '1'

import { expect } from 'chai'
import { PrismaClient } from '@prisma/client'

let markTxQueueFailed: typeof import('../../src/utils/txQueueFailure').markTxQueueFailed
let countManager: typeof import('../../src/services/CountManager').countManager
let cleanupPendingReplies: typeof import('../../src/services/DataCleaner').cleanupPendingReplies
let cleanupPendingCaws: typeof import('../../src/services/DataCleaner').cleanupPendingCaws
let deleteReplyRowAndCount: typeof import('../../src/services/DataCleaner').deleteReplyRowAndCount

const prisma = new PrismaClient()

const AUTHOR = 96001
const REPLIER = 96002
const OTHER = 96003
const USERS = [AUTHOR, REPLIER, OTHER]

let cawonceSeq = 9000
const nextCawonce = () => ++cawonceSeq
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

const commentCount = async (id: number) =>
  (await prisma.caw.findUnique({ where: { id }, select: { commentCount: true } }))!.commentCount
const replyRows = (cawId: number) => prisma.reply.count({ where: { cawId } })

async function makeParent() {
  return prisma.caw.create({
    data: { userId: AUTHOR, cawonce: nextCawonce(), content: 'parent', status: 'SUCCESS', action: 'CAW' } as any,
  })
}

// What /api/actions and /api/actions/batch write for a reply: the PENDING Caw,
// the pending Reply row and the parent's +1.
async function submitReply(parentId: number, userId = REPLIER, content = 'a reply') {
  const cawonce = nextCawonce()
  const reply = await prisma.caw.create({
    data: { userId, cawonce, content, status: 'PENDING', action: 'CAW', originalCawId: parentId } as any,
  })
  await countManager.onCawCreated(prisma as any, {
    id: reply.id, userId, action: 'CAW', originalCawId: null, status: 'PENDING', isReply: true,
  })
  await prisma.reply.create({ data: { userId, cawId: parentId, replyCawId: reply.id, pending: true } })
  await countManager.onReplyCreated(prisma as any, { cawId: parentId, replyCawId: reply.id, pending: true })
  return { reply, cawonce, userId }
}

// The validator rejecting it.
async function validatorFails(r: { cawonce: number; userId: number }) {
  const data = { senderId: r.userId, actionType: 0, cawonce: r.cawonce, text: '0x' }
  const tx = await prisma.txQueue.create({
    data: { senderId: r.userId, cawonce: r.cawonce, status: 'processing', signedTx: '0x00', payload: { data } as any },
  })
  await markTxQueueFailed(prisma as any, tx.id, 'Simulation rejected - reverted', r.userId, data)
}

// The pending-reply sweeps look at rows older than 5 (and 30) minutes.
async function age(r: { reply: { id: number } }, minutes: number) {
  await prisma.reply.updateMany({ where: { replyCawId: r.reply.id }, data: { createdAt: minutesAgo(minutes) } })
  await prisma.caw.update({ where: { id: r.reply.id }, data: { createdAt: minutesAgo(minutes) } })
}

// The indexer confirming a pending reply (actionHandlers.ts: a reply that was
// pending adds nothing to commentCount).
async function confirm(r: { reply: { id: number } }) {
  await prisma.caw.update({ where: { id: r.reply.id }, data: { status: 'SUCCESS' } })
  await prisma.reply.updateMany({ where: { replyCawId: r.reply.id, pending: true }, data: { pending: false } })
}

describe('commentCount after a stale failed reply is swept', function () {
  this.timeout(60000)

  async function clean() {
    await prisma.reply.deleteMany({ where: { OR: [{ userId: { in: USERS } }, { replyCaw: { userId: { in: USERS } } }] } })
    await prisma.notification.deleteMany({ where: { userId: { in: USERS } } })
    await prisma.txQueue.deleteMany({ where: { senderId: { in: USERS } } })
    await prisma.caw.deleteMany({ where: { userId: { in: USERS } } })
  }

  before(async () => {
    if (!/caw_test_/.test(process.env.DATABASE_URL || '')) {
      throw new Error('needs DATABASE_URL pointing at a caw_test_* database')
    }
    const es = process.env.ELASTICSEARCH_NODE
    if (!es || /localhost|127\.0\.0\.1:9200/.test(es)) {
      throw new Error('needs ELASTICSEARCH_NODE set to an unreachable address (e.g. http://127.0.0.1:1)')
    }
    ;({ markTxQueueFailed } = await import('../../src/utils/txQueueFailure'))
    ;({ countManager } = await import('../../src/services/CountManager'))
    ;({ cleanupPendingReplies, cleanupPendingCaws, deleteReplyRowAndCount } = await import('../../src/services/DataCleaner'))
    for (const id of USERS) {
      await prisma.user.upsert({
        where: { tokenId: id },
        update: {},
        create: { id, tokenId: id, username: `rcaf${id}` },
      })
    }
  })

  beforeEach(clean)

  after(async () => {
    await clean()
    await prisma.user.deleteMany({ where: { tokenId: { in: USERS } } })
    await prisma.$disconnect()
  })

  describe('the stale-reply sweeps', () => {
    it('a stale FAILED reply is swept while a newer reply to the same post is pending: the pending one stays counted, also after it confirms', async () => {
      const parent = await makeParent()
      const old = await submitReply(parent.id)
      await validatorFails(old)
      await age(old, 10)
      const fresh = await submitReply(parent.id)
      expect(await commentCount(parent.id)).to.equal(2)

      await cleanupPendingReplies()
      expect(await replyRows(parent.id)).to.equal(1)
      expect(await commentCount(parent.id)).to.equal(1)

      await confirm(fresh)
      expect(await commentCount(parent.id)).to.equal(1)
    })

    it('another user\'s pending reply under the same post is not dropped from the count', async () => {
      const parent = await makeParent()
      const stale = await submitReply(parent.id, REPLIER, 'x')
      await validatorFails(stale)
      await age(stale, 10)
      const other = await submitReply(parent.id, OTHER, 'y')

      await cleanupPendingReplies()
      expect(await commentCount(parent.id)).to.equal(1)
      await confirm(other)
      expect(await commentCount(parent.id)).to.equal(1)
    })

    it('confirmed replies stay counted', async () => {
      const parent = await makeParent()
      const done1 = await submitReply(parent.id, OTHER, 'one')
      await confirm(done1)
      const done2 = await submitReply(parent.id, OTHER, 'two')
      await confirm(done2)
      const stale = await submitReply(parent.id)
      await validatorFails(stale)
      await age(stale, 10)
      expect(await commentCount(parent.id)).to.equal(3)

      await cleanupPendingReplies()
      expect(await commentCount(parent.id)).to.equal(2)
      expect(await replyRows(parent.id)).to.equal(2)
    })

    it('a reply stuck in PENDING for over 30 minutes is failed and removed; other pending replies stay counted', async () => {
      const parent = await makeParent()
      const stuck = await submitReply(parent.id)
      await age(stuck, 40)
      const other = await submitReply(parent.id, OTHER, 'y')

      await cleanupPendingReplies()
      expect((await prisma.caw.findUnique({ where: { id: stuck.reply.id } }))!.status).to.equal('FAILED')
      expect(await replyRows(parent.id)).to.equal(1)
      expect(await commentCount(parent.id)).to.equal(1)
      await confirm(other)
      expect(await commentCount(parent.id)).to.equal(1)
    })

    it('a caw stuck in PENDING for over 30 minutes is failed with its Reply row; other pending replies stay counted', async () => {
      const parent = await makeParent()
      const stuck = await submitReply(parent.id)
      await prisma.caw.update({ where: { id: stuck.reply.id }, data: { createdAt: minutesAgo(40) } })
      const other = await submitReply(parent.id, OTHER, 'y')

      await cleanupPendingCaws()
      expect((await prisma.caw.findUnique({ where: { id: stuck.reply.id } }))!.status).to.equal('FAILED')
      expect(await replyRows(parent.id)).to.equal(1)
      expect(await commentCount(parent.id)).to.equal(1)
      await confirm(other)
      expect(await commentCount(parent.id)).to.equal(1)
    })
  })

  // The single-action path in /api/actions commits the pending Reply row and only
  // then runs onReplyCreated (+1) as a separate statement. A sweep that lands in
  // between must not count that reply: its +1 is still to come.
  describe('a reply whose row is committed before its +1', () => {
    // The Caw and the pending Reply row, without the +1 (that is the gap).
    async function submitRowOnly(parentId: number, userId = OTHER) {
      const cawonce = nextCawonce()
      const reply = await prisma.caw.create({
        data: { userId, cawonce, content: 'row first', status: 'PENDING', action: 'CAW', originalCawId: parentId } as any,
      })
      await prisma.reply.create({ data: { userId, cawId: parentId, replyCawId: reply.id, pending: true } })
      return reply
    }
    const plusOne = (parentId: number, replyCawId: number) =>
      countManager.onReplyCreated(prisma as any, { cawId: parentId, replyCawId, pending: true })

    it('stale FAILED reply swept in the gap: the count is right once the +1 runs', async () => {
      const parent = await makeParent()
      const stale = await submitReply(parent.id)
      await validatorFails(stale)
      await age(stale, 10)
      const gap = await submitRowOnly(parent.id)

      await cleanupPendingReplies()
      await plusOne(parent.id, gap.id)
      expect(await replyRows(parent.id)).to.equal(1)
      expect(await commentCount(parent.id)).to.equal(1)
    })

    it('reply stuck in PENDING over 30 minutes swept in the gap', async () => {
      const parent = await makeParent()
      const stuck = await submitReply(parent.id)
      await age(stuck, 40)
      const gap = await submitRowOnly(parent.id)

      await cleanupPendingReplies()
      await plusOne(parent.id, gap.id)
      expect(await replyRows(parent.id)).to.equal(1)
      expect(await commentCount(parent.id)).to.equal(1)
    })

    it('caw stuck in PENDING over 30 minutes swept in the gap', async () => {
      const parent = await makeParent()
      const stuck = await submitReply(parent.id)
      await prisma.caw.update({ where: { id: stuck.reply.id }, data: { createdAt: minutesAgo(40) } })
      const gap = await submitRowOnly(parent.id)

      await cleanupPendingCaws()
      await plusOne(parent.id, gap.id)
      expect(await replyRows(parent.id)).to.equal(1)
      expect(await commentCount(parent.id)).to.equal(1)
    })

    it('the +1 first, then the sweep: still right', async () => {
      const parent = await makeParent()
      const stale = await submitReply(parent.id)
      await validatorFails(stale)
      await age(stale, 10)
      const gap = await submitRowOnly(parent.id)
      await plusOne(parent.id, gap.id)

      await cleanupPendingReplies()
      expect(await replyRows(parent.id)).to.equal(1)
      expect(await commentCount(parent.id)).to.equal(1)
    })
  })

  describe('deleteReplyRowAndCount', () => {
    it('takes 1 off once per row: a second call for the same row changes nothing', async () => {
      const parent = await makeParent()
      const a = await submitReply(parent.id, REPLIER, 'a')
      await submitReply(parent.id, OTHER, 'b')
      const row = (await prisma.reply.findFirst({ where: { replyCawId: a.reply.id } }))!
      expect(await commentCount(parent.id)).to.equal(2)

      expect(await deleteReplyRowAndCount(row.id, parent.id)).to.equal(true)
      expect(await deleteReplyRowAndCount(row.id, parent.id)).to.equal(false)
      expect(await commentCount(parent.id)).to.equal(1)
      expect(await replyRows(parent.id)).to.equal(1)
    })

    it('never goes below zero', async () => {
      const parent = await makeParent()
      const a = await submitReply(parent.id)
      await prisma.caw.update({ where: { id: parent.id }, data: { commentCount: 0 } })
      const row = (await prisma.reply.findFirst({ where: { replyCawId: a.reply.id } }))!
      await deleteReplyRowAndCount(row.id, parent.id)
      expect(await commentCount(parent.id)).to.equal(0)
    })
  })
})

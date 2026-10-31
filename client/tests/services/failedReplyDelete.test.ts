// Dismissing (or retrying) a failed reply must not fail on the Reply row.
//
// A reply that the validator rejects keeps its pending Reply row and the +1 on
// the parent's commentCount (markTxQueueFailed only marks the Caw FAILED).
// Reply.replyCawId is a RESTRICT foreign key into Caw, so deleting the FAILED
// caw failed with P2003. deleteFailedCaws removes the Reply row first and
// gives back the commentCount.
//
// Integration-style against a real database: the failure goes through the real
// markTxQueueFailed and the optimistic rows are written with the real
// CountManager. Needs DATABASE_URL pointing at a disposable database whose name
// contains "caw_test_", and ELASTICSEARCH_NODE set to an unreachable address
// (importing the services starts an Elasticsearch sync); the guards run in
// before(), ahead of the dynamic imports.

process.env.CLIENT_ID = '1'

import { expect } from 'chai'
import { PrismaClient } from '@prisma/client'

let markTxQueueFailed: typeof import('../../src/utils/txQueueFailure').markTxQueueFailed
let deleteFailedCaws: typeof import('../../src/api/shared/failedCaw').deleteFailedCaws
let deleteReplacedFailedCaws: typeof import('../../src/api/shared/failedCaw').deleteReplacedFailedCaws
let countManager: typeof import('../../src/services/CountManager').countManager

const prisma = new PrismaClient()

const AUTHOR = 92001
const REPLIER = 92002
const OTHER = 92003
const USERS = [AUTHOR, REPLIER, OTHER]

let cawonceSeq = 5000
const nextCawonce = () => ++cawonceSeq

const commentCount = async (id: number) =>
  (await prisma.caw.findUnique({ where: { id }, select: { commentCount: true } }))!.commentCount

async function makeParent() {
  return prisma.caw.create({
    data: { userId: AUTHOR, cawonce: nextCawonce(), content: 'parent', status: 'SUCCESS', action: 'CAW' } as any,
  })
}

// What /api/actions writes for a reply: the PENDING Caw, the pending Reply row
// and the parent's +1.
async function submitReply(parentId: number, opts: { userId?: number; content?: string } = {}) {
  const userId = opts.userId ?? REPLIER
  const cawonce = nextCawonce()
  const reply = await prisma.caw.create({
    data: { userId, cawonce, content: opts.content ?? 'a reply', status: 'PENDING', action: 'CAW', originalCawId: parentId } as any,
  })
  await countManager.onCawCreated(prisma as any, {
    id: reply.id, userId, action: 'CAW', originalCawId: null, status: 'PENDING', isReply: true,
  })
  await prisma.reply.create({ data: { userId, cawId: parentId, replyCawId: reply.id, pending: true } })
  await countManager.onReplyCreated(prisma as any, { cawId: parentId, replyCawId: reply.id, pending: true })
  return { reply, cawonce, userId }
}

// The validator rejecting the reply.
async function validatorFails(r: { cawonce: number; userId: number }) {
  const data = { senderId: r.userId, actionType: 0, cawonce: r.cawonce, text: '0x' }
  const tx = await prisma.txQueue.create({
    data: { senderId: r.userId, cawonce: r.cawonce, status: 'processing', signedTx: '0x00', payload: { data } as any },
  })
  await markTxQueueFailed(prisma as any, tx.id, 'Simulation rejected - reverted', r.userId, data)
}

describe('deleteFailedCaws (dismiss / retry cleanup of a failed caw)', function () {
  this.timeout(60000)

  async function clean() {
    await prisma.reply.deleteMany({ where: { OR: [{ userId: { in: USERS } }, { replyCaw: { userId: { in: USERS } } }] } })
    await prisma.tip.deleteMany({ where: { senderId: { in: USERS } } })
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
    ;({ deleteFailedCaws, deleteReplacedFailedCaws } = await import('../../src/api/shared/failedCaw'))
    ;({ countManager } = await import('../../src/services/CountManager'))
    for (const id of USERS) {
      await prisma.user.upsert({
        where: { tokenId: id },
        update: {},
        create: { id, tokenId: id, username: `fcdel${id}` },
      })
    }
  })

  beforeEach(clean)

  after(async () => {
    await clean()
    await prisma.user.deleteMany({ where: { tokenId: { in: USERS } } })
    await prisma.$disconnect()
  })

  it('shows the problem: a failed reply keeps its Reply row and the parent count, and a plain delete is rejected', async () => {
    const parent = await makeParent()
    const r = await submitReply(parent.id)
    await validatorFails(r)

    expect((await prisma.caw.findUnique({ where: { id: r.reply.id } }))!.status).to.equal('FAILED')
    expect(await prisma.reply.count({ where: { replyCawId: r.reply.id } })).to.equal(1)
    expect(await commentCount(parent.id)).to.equal(1)

    let code: string | undefined
    try {
      await prisma.caw.deleteMany({ where: { id: r.reply.id, status: 'FAILED' } })
    } catch (e: any) {
      code = e.code
    }
    expect(code).to.equal('P2003')
  })

  it('deletes a failed reply, its Reply row, and gives back the parent commentCount', async () => {
    const parent = await makeParent()
    const r = await submitReply(parent.id)
    await validatorFails(r)

    expect(await deleteFailedCaws(prisma, { id: r.reply.id })).to.equal(1)
    expect(await prisma.caw.findUnique({ where: { id: r.reply.id } })).to.equal(null)
    expect(await prisma.reply.count({ where: { replyCawId: r.reply.id } })).to.equal(0)
    expect(await commentCount(parent.id)).to.equal(0)
  })

  it('leaves the counts of the parent\'s other replies alone', async () => {
    const parent = await makeParent()
    const failing = await submitReply(parent.id)
    await submitReply(parent.id, { userId: OTHER })
    expect(await commentCount(parent.id)).to.equal(2)
    await validatorFails(failing)

    await deleteFailedCaws(prisma, { id: failing.reply.id })
    expect(await commentCount(parent.id)).to.equal(1)
    expect(await prisma.reply.count({ where: { cawId: parent.id } })).to.equal(1)
  })

  it('gives the count back once when the same caw is dismissed twice at the same time', async () => {
    const parent = await makeParent()
    const failing = await submitReply(parent.id)
    await submitReply(parent.id, { userId: OTHER })
    await validatorFails(failing)

    const results = await Promise.all([
      deleteFailedCaws(prisma, { id: failing.reply.id }),
      deleteFailedCaws(prisma, { id: failing.reply.id }),
    ])
    expect(results.reduce((a, b) => a + b, 0)).to.equal(1)
    expect(await commentCount(parent.id)).to.equal(1)
  })

  it('only deletes FAILED caws: a PENDING or SUCCESS reply keeps its row and count', async () => {
    const parent = await makeParent()
    const pending = await submitReply(parent.id)
    const done = await submitReply(parent.id, { userId: OTHER })
    await prisma.caw.update({ where: { id: done.reply.id }, data: { status: 'SUCCESS' } })

    expect(await deleteFailedCaws(prisma, { id: pending.reply.id })).to.equal(0)
    expect(await deleteFailedCaws(prisma, { id: done.reply.id })).to.equal(0)
    expect(await prisma.caw.count({ where: { id: { in: [pending.reply.id, done.reply.id] } } })).to.equal(2)
    expect(await prisma.reply.count({ where: { cawId: parent.id } })).to.equal(2)
    expect(await commentCount(parent.id)).to.equal(2)
  })

  it('returns 0 for an id that does not exist', async () => {
    expect(await deleteFailedCaws(prisma, { id: 2147483000 })).to.equal(0)
  })

  it('deletes a failed plain caw; a Tip on it and a caw that quotes it survive with the link cleared', async () => {
    const failed = await prisma.caw.create({
      data: { userId: REPLIER, cawonce: nextCawonce(), content: 'plain', status: 'FAILED', action: 'CAW' } as any,
    })
    const tip = await prisma.tip.create({
      data: { senderId: REPLIER, recipientId: AUTHOR, amount: 5, cawId: failed.id, cawonce: nextCawonce(), pending: false },
    })
    const quote = await prisma.caw.create({
      data: { userId: OTHER, cawonce: nextCawonce(), content: 'quote', status: 'SUCCESS', action: 'RECAW', originalCawId: failed.id } as any,
    })

    expect(await deleteFailedCaws(prisma, { id: failed.id })).to.equal(1)
    expect((await prisma.tip.findUnique({ where: { id: tip.id } }))!.cawId).to.equal(null)
    expect((await prisma.caw.findUnique({ where: { id: quote.id } }))!.originalCawId).to.equal(null)
  })

  it('retry cleanup: removes the sender\'s FAILED caws with the same content, not the new caw or other senders\'', async () => {
    const parent = await makeParent()
    const old1 = await submitReply(parent.id, { content: 'same text' })
    const old2 = await submitReply(parent.id, { content: 'same text' })
    await validatorFails(old1)
    await validatorFails(old2)
    const other = await prisma.caw.create({
      data: { userId: OTHER, cawonce: nextCawonce(), content: 'same text', status: 'FAILED', action: 'CAW', originalCawId: parent.id } as any,
    })
    const retry = await submitReply(parent.id, { content: 'same text' })
    expect(await commentCount(parent.id)).to.equal(3)

    const removed = await deleteReplacedFailedCaws(prisma, {
      userId: REPLIER,
      content: 'same text',
      isRecaw: false,
      originalCawId: parent.id,
      excludeCawId: retry.reply.id,
    })
    expect(removed).to.equal(2)
    expect(await prisma.caw.count({ where: { id: { in: [old1.reply.id, old2.reply.id] } } })).to.equal(0)
    expect(await prisma.caw.count({ where: { id: { in: [other.id, retry.reply.id] } } })).to.equal(2)
    // only the retry's own +1 is left
    expect(await commentCount(parent.id)).to.equal(1)
    expect(await prisma.reply.count({ where: { replyCawId: retry.reply.id } })).to.equal(1)
  })

  it('retry cleanup: does not remove FAILED replies to a different parent (R01-F1)', async () => {
    const parentX = await makeParent()
    const parentY = await makeParent()
    const replyX = await submitReply(parentX.id, { content: 'same text' })
    const replyY = await submitReply(parentY.id, { content: 'same text' })
    await validatorFails(replyX)
    await validatorFails(replyY)
    expect(await commentCount(parentX.id)).to.equal(1)
    expect(await commentCount(parentY.id)).to.equal(1)

    // User resubmits to parentX
    const retryX = await submitReply(parentX.id, { content: 'same text' })
    expect(await commentCount(parentX.id)).to.equal(2)

    const removed = await deleteReplacedFailedCaws(prisma, {
      userId: REPLIER,
      content: 'same text',
      isRecaw: false,
      originalCawId: parentX.id,
      excludeCawId: retryX.reply.id,
    })
    expect(removed).to.equal(1)
    // replyX is removed, parentX count is decremented back to 1 (only retryX's own +1 remains)
    expect(await prisma.caw.count({ where: { id: replyX.reply.id } })).to.equal(0)
    expect(await commentCount(parentX.id)).to.equal(1)

    // replyY is NOT removed, parentY count remains intact
    expect(await prisma.caw.count({ where: { id: replyY.reply.id } })).to.equal(1)
    expect(await commentCount(parentY.id)).to.equal(1)
  })

  it('retry cleanup: top-level caw does not remove FAILED replies with same content', async () => {
    const parent = await makeParent()
    const reply = await submitReply(parent.id, { content: 'same text' })
    await validatorFails(reply)
    expect(await commentCount(parent.id)).to.equal(1)

    // User submits top-level post with same text
    const topLevel = await prisma.caw.create({
      data: { userId: REPLIER, cawonce: nextCawonce(), content: 'same text', status: 'PENDING', action: 'CAW', originalCawId: null } as any,
    })

    const removed = await deleteReplacedFailedCaws(prisma, {
      userId: REPLIER,
      content: 'same text',
      isRecaw: false,
      originalCawId: undefined,
      excludeCawId: topLevel.id,
    })
    expect(removed).to.equal(0)
    expect(await prisma.caw.count({ where: { id: reply.reply.id } })).to.equal(1)
    expect(await commentCount(parent.id)).to.equal(1)
  })

  it('retry cleanup: a reply does not remove a FAILED quote of the same post with the same text, and the other way round', async () => {
    const parent = await makeParent()
    const failedQuote = await prisma.caw.create({
      data: { userId: REPLIER, cawonce: nextCawonce(), content: 'same text', status: 'FAILED', action: 'RECAW', originalCawId: parent.id } as any,
    })
    const failedReply = await submitReply(parent.id, { content: 'same text' })
    await validatorFails(failedReply)

    const newReply = await submitReply(parent.id, { content: 'same text' })
    const asReply = await deleteReplacedFailedCaws(prisma, {
      userId: REPLIER, content: 'same text', isRecaw: false, originalCawId: parent.id, excludeCawId: newReply.reply.id,
    })
    expect(asReply).to.equal(1)
    expect(await prisma.caw.count({ where: { id: failedQuote.id } })).to.equal(1)
    expect(await prisma.caw.count({ where: { id: failedReply.reply.id } })).to.equal(0)

    const newQuote = await prisma.caw.create({
      data: { userId: REPLIER, cawonce: nextCawonce(), content: 'same text', status: 'PENDING', action: 'RECAW', originalCawId: parent.id } as any,
    })
    const failedReply2 = await submitReply(parent.id, { content: 'same text' })
    await validatorFails(failedReply2)
    const asQuote = await deleteReplacedFailedCaws(prisma, {
      userId: REPLIER, content: 'same text', isRecaw: true, originalCawId: parent.id, excludeCawId: newQuote.id,
    })
    expect(asQuote).to.equal(1)
    expect(await prisma.caw.count({ where: { id: failedQuote.id } })).to.equal(0)
    expect(await prisma.caw.count({ where: { id: failedReply2.reply.id } })).to.equal(1)
  })

  it('changes nothing when the caw stops being FAILED while it is being deleted', async () => {
    const parent = await makeParent()
    const r = await submitReply(parent.id)
    await validatorFails(r)

    // The action lands on chain after all and another writer confirms the caw
    // (FAILED -> SUCCESS). Hold that write open so the delete has to wait for it.
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let confirmed!: () => void
    const confirmedWrite = new Promise<void>((resolve) => { confirmed = resolve })
    const other = prisma.$transaction(async (tx) => {
      await tx.caw.update({ where: { id: r.reply.id }, data: { status: 'SUCCESS' } })
      confirmed()
      await gate
    }, { timeout: 30000 })
    await confirmedWrite

    const deleting = deleteFailedCaws(prisma, { id: r.reply.id })
    await new Promise((resolve) => setTimeout(resolve, 500))
    release()
    await other

    expect(await deleting).to.equal(0)
    expect((await prisma.caw.findUnique({ where: { id: r.reply.id } }))!.status).to.equal('SUCCESS')
    expect(await prisma.reply.count({ where: { replyCawId: r.reply.id } })).to.equal(1)
    expect(await commentCount(parent.id)).to.equal(1)
  })

  it('does not give back a count that another writer already gave back', async () => {
    const parent = await makeParent()
    const failing = await submitReply(parent.id)
    await submitReply(parent.id, { userId: OTHER })
    await validatorFails(failing)
    expect(await commentCount(parent.id)).to.equal(2)

    // Another writer removes the Reply row and gives its +1 back; hold it open
    // so the delete has to wait for it.
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let written!: () => void
    const otherWrote = new Promise<void>((resolve) => { written = resolve })
    const other = prisma.$transaction(async (tx) => {
      await tx.reply.deleteMany({ where: { replyCawId: failing.reply.id } })
      await tx.caw.update({ where: { id: parent.id }, data: { commentCount: { decrement: 1 } } })
      written()
      await gate
    }, { timeout: 30000 })
    await otherWrote

    const deleting = deleteFailedCaws(prisma, { id: failing.reply.id })
    await new Promise((resolve) => setTimeout(resolve, 500))
    release()
    await other

    expect(await deleting).to.equal(1)
    expect(await prisma.caw.findUnique({ where: { id: failing.reply.id } })).to.equal(null)
    expect(await commentCount(parent.id)).to.equal(1)
  })

  it('removes a Reply row that is not pending without touching the count', async () => {
    const parent = await makeParent()
    const r = await submitReply(parent.id)
    await prisma.reply.updateMany({ where: { replyCawId: r.reply.id }, data: { pending: false } })
    await prisma.caw.update({ where: { id: r.reply.id }, data: { status: 'FAILED' } })

    expect(await deleteFailedCaws(prisma, { id: r.reply.id })).to.equal(1)
    expect(await prisma.reply.count({ where: { replyCawId: r.reply.id } })).to.equal(0)
    expect(await commentCount(parent.id)).to.equal(1)
  })
})

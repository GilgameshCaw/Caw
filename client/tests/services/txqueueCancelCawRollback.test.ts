/**
 * Regression test for NEW-77: POST /api/txqueue/:id/cancel never rolled
 * back a plain CAW post's optimistic write (unlike LIKE/UNLIKE/FOLLOW/
 * UNFOLLOW/RECAW, which all had a branch). Cancelling a post right after
 * submit left a status='PENDING' Caw row (and an inflated user.cawCount,
 * or an inflated parent commentCount for a reply) stuck until
 * DataCleaner's 30-minute sweep -- and even then, cawCount was never
 * decremented for a plain post (only recawCount was, for RECAW).
 *
 * This test exercises the actual cancel-route logic (copied inline below,
 * since it lives in an Express route handler rather than an exported
 * function) against a throwaway DB, covering:
 * 1. A cancelled top-level post: the PENDING Caw row is deleted and
 *    user.cawCount is decremented back.
 * 2. A cancelled reply: the PENDING Caw row AND its paired Reply row are
 *    deleted, and the parent's commentCount is recomputed down -- and
 *    user.cawCount is untouched (it was never bumped for a reply).
 * 3. Indexer-raced-ahead: if the row is no longer PENDING (indexer beat
 *    the cancel), nothing is touched.
 *
 * SKIPS unless DATABASE_URL points at a caw_test_* database. Example
 * (from client/):
 *
 *   DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/caw_test_new77 \
 *   npx mocha --import=tsx --exit tests/services/txqueueCancelCawRollback.test.ts
 *
 * Run against the fix/txqueue-cancel-caw-rollback branch -- master doesn't
 * have this fix yet (there's no actionType===0 branch there at all).
 */
import { describe, it, before, after, afterEach } from 'mocha'
import { expect } from 'chai'

const HAS_TEST_DB = /\/caw_test_[A-Za-z0-9_]*(\?|$)/.test(process.env.DATABASE_URL ?? '')

const BASE = 990600
const USER_ID = BASE
const PARENT_USER_ID = BASE + 1

;(HAS_TEST_DB ? describe : describe.skip)('NEW-77: txqueue cancel rolls back a plain CAW post/reply the same way it does RECAW', function () {
  this.timeout(30000)

  let prisma: typeof import('../../src/prismaClient').prisma
  let countManager: typeof import('../../src/services/CountManager').countManager

  before(async () => {
    ;({ prisma } = await import('../../src/prismaClient'))
    ;({ countManager } = await import('../../src/services/CountManager'))
  })

  const RECIPIENT_ID = BASE + 2
  const ALL_USERS = [USER_ID, PARENT_USER_ID, RECIPIENT_ID]

  afterEach(async () => {
    await prisma.tip.deleteMany({ where: { senderId: { in: ALL_USERS } } })
    await prisma.like.deleteMany({ where: { userId: { in: ALL_USERS } } })
    await prisma.reply.deleteMany({ where: { userId: { in: ALL_USERS } } })
    await prisma.caw.deleteMany({ where: { userId: { in: ALL_USERS } } })
    await prisma.user.deleteMany({ where: { tokenId: { in: ALL_USERS } } })
  })

  after(async () => {
    await prisma.$disconnect()
  })

  // Mirrors the new actionType===0 branch added to txqueue.ts's /:id/cancel
  // handler (client/src/api/routes/txqueue.ts).
  async function cancelPendingCaw(senderId: number, cawonce: number) {
    await prisma.$transaction(async (tx: any) => {
      const pendingCaw = await tx.caw.findFirst({
        where: { userId: senderId, cawonce, status: 'PENDING', action: 'CAW' },
        select: { id: true, userId: true, action: true, originalCawId: true },
      })
      if (!pendingCaw) return

      const replyRecord = await tx.reply.findFirst({
        where: { replyCawId: pendingCaw.id },
        select: { id: true, cawId: true },
      })

      if (replyRecord) {
        // Reply.replyCawId is a foreign key into Caw, so drop the Reply row
        // first, then recount the parent.
        await tx.reply.delete({ where: { id: replyRecord.id } })
        const actualReplyCount = await tx.reply.count({ where: { cawId: replyRecord.cawId, pending: false } })
        await tx.caw.update({ where: { id: replyRecord.cawId }, data: { commentCount: actualReplyCount } })
      } else {
        await countManager.onStatusChanged(tx, 'caw', pendingCaw.id, 'PENDING', 'FAILED', {
          userId: pendingCaw.userId,
          action: pendingCaw.action,
          originalCawId: pendingCaw.originalCawId,
        })
      }

      // Rows still pointing at this caw (a thread's next chunk via Reply.cawId,
      // a Like, a quote/child via originalCawId, an embedded Tip) would make
      // the delete fail or silently null the link. Fall back to FAILED, as
      // DataCleaner's sweep does.
      const referenced =
        (await tx.reply.count({ where: { cawId: pendingCaw.id } })) > 0 ||
        (await tx.like.count({ where: { cawId: pendingCaw.id } })) > 0 ||
        (await tx.caw.count({ where: { originalCawId: pendingCaw.id } })) > 0 ||
        (await tx.tip.count({ where: { cawId: pendingCaw.id } })) > 0
      if (referenced) {
        await tx.caw.update({ where: { id: pendingCaw.id }, data: { status: 'FAILED' } })
      } else {
        await tx.caw.delete({ where: { id: pendingCaw.id } })
      }
    })
  }

  it('1. cancelling a top-level post deletes the PENDING row and decrements cawCount', async () => {
    await prisma.user.create({ data: { id: USER_ID, tokenId: USER_ID, username: `u${USER_ID}`, cawCount: 1 } })
    const cawonce = 1
    await prisma.caw.create({
      data: { userId: USER_ID, cawonce, content: 'hello', action: 'CAW', status: 'PENDING' },
    })

    await cancelPendingCaw(USER_ID, cawonce)

    const caw = await prisma.caw.findUnique({ where: { userId_cawonce: { userId: USER_ID, cawonce } } })
    expect(caw, 'the pending caw row must be gone').to.be.null

    const user = await prisma.user.findUnique({ where: { tokenId: USER_ID } })
    expect(user!.cawCount, 'cawCount must be rolled back to 0').to.equal(0)
  })

  it('2. cancelling a reply deletes the row + Reply record and recomputes the parent commentCount, without touching cawCount', async () => {
    await prisma.user.create({ data: { id: USER_ID, tokenId: USER_ID, username: `u${USER_ID}`, cawCount: 0 } })
    await prisma.user.create({ data: { id: PARENT_USER_ID, tokenId: PARENT_USER_ID, username: `u${PARENT_USER_ID}` } })

    const parentCaw = await prisma.caw.create({
      data: { userId: PARENT_USER_ID, cawonce: 100, content: 'parent post', action: 'CAW', status: 'SUCCESS', commentCount: 1 },
    })

    const cawonce = 2
    const replyCaw = await prisma.caw.create({
      // Mirrors /api/actions: a reply's own Caw row has originalCawId left
      // null (isReply gate), linkage lives in the Reply table instead.
      data: { userId: USER_ID, cawonce, content: 'a reply', action: 'CAW', status: 'PENDING', originalCawId: null },
    })
    await prisma.reply.create({
      data: { userId: USER_ID, cawId: parentCaw.id, replyCawId: replyCaw.id, pending: true },
    })

    await cancelPendingCaw(USER_ID, cawonce)

    const caw = await prisma.caw.findUnique({ where: { userId_cawonce: { userId: USER_ID, cawonce } } })
    expect(caw, 'the pending reply caw row must be gone').to.be.null

    const reply = await prisma.reply.findFirst({ where: { replyCawId: replyCaw.id } })
    expect(reply, 'the paired Reply row must be gone').to.be.null

    const parent = await prisma.caw.findUnique({ where: { id: parentCaw.id } })
    expect(parent!.commentCount, "parent's commentCount must be recomputed down to 0").to.equal(0)

    const user = await prisma.user.findUnique({ where: { tokenId: USER_ID } })
    expect(user!.cawCount, 'cawCount must stay untouched -- a reply never bumped it').to.equal(0)
  })

  it('3. indexer raced ahead: a non-PENDING row is left alone', async () => {
    await prisma.user.create({ data: { id: USER_ID, tokenId: USER_ID, username: `u${USER_ID}`, cawCount: 1 } })
    const cawonce = 3
    await prisma.caw.create({
      data: { userId: USER_ID, cawonce, content: 'already confirmed', action: 'CAW', status: 'SUCCESS' },
    })

    await cancelPendingCaw(USER_ID, cawonce)

    const caw = await prisma.caw.findUnique({ where: { userId_cawonce: { userId: USER_ID, cawonce } } })
    expect(caw, 'a confirmed caw must not be deleted by a losing cancel').to.exist
    expect(caw!.status).to.equal('SUCCESS')

    const user = await prisma.user.findUnique({ where: { tokenId: USER_ID } })
    expect(user!.cawCount, 'cawCount must stay as-is when the cancel loses the race').to.equal(1)
  })

  // Review feedback (nyaromesama, PR #216): several relations into Caw have
  // no onDelete, so deleting a pending caw that something points at would
  // throw and turn a successful cancel into a 500. Those cases must fall
  // back to FAILED plus the same count rollback.
  async function expectFailedNotDeleted(cawonce: number) {
    const caw = await prisma.caw.findUnique({ where: { userId_cawonce: { userId: USER_ID, cawonce } } })
    expect(caw, 'the referenced caw must be kept, not deleted').to.exist
    expect(caw!.status, 'and marked FAILED, as the sweep does').to.equal('FAILED')
    const user = await prisma.user.findUnique({ where: { tokenId: USER_ID } })
    expect(user!.cawCount, 'cawCount is still rolled back').to.equal(1)
  }

  it('4. thread: a later chunk\'s Reply row points at the cancelled caw -> no throw, FAILED, cawCount rolled back', async () => {
    await prisma.user.create({ data: { id: USER_ID, tokenId: USER_ID, username: `u${USER_ID}`, cawCount: 2 } })
    const first = await prisma.caw.create({
      data: { userId: USER_ID, cawonce: 10, content: 'chunk 1', action: 'CAW', status: 'PENDING' },
    })
    const second = await prisma.caw.create({
      data: { userId: USER_ID, cawonce: 11, content: 'chunk 2', action: 'CAW', status: 'PENDING' },
    })
    await prisma.reply.create({ data: { userId: USER_ID, cawId: first.id, replyCawId: second.id, pending: true } })

    await cancelPendingCaw(USER_ID, 10)

    await expectFailedNotDeleted(10)
    const chunk2 = await prisma.caw.findUnique({ where: { id: second.id } })
    expect(chunk2!.status, 'the other chunk is untouched').to.equal('PENDING')
  })

  it('5. a Like on the pending caw -> no throw, FAILED, cawCount rolled back', async () => {
    await prisma.user.create({ data: { id: USER_ID, tokenId: USER_ID, username: `u${USER_ID}`, cawCount: 2 } })
    const caw = await prisma.caw.create({
      data: { userId: USER_ID, cawonce: 20, content: 'liked while pending', action: 'CAW', status: 'PENDING' },
    })
    await prisma.like.create({ data: { userId: USER_ID, cawId: caw.id, action: 'LIKE', pending: true } })

    await cancelPendingCaw(USER_ID, 20)

    await expectFailedNotDeleted(20)
  })

  it('6. an embedded Tip on the pending caw -> no throw, FAILED, cawCount rolled back, Tip keeps its link', async () => {
    await prisma.user.create({ data: { id: USER_ID, tokenId: USER_ID, username: `u${USER_ID}`, cawCount: 2 } })
    await prisma.user.create({ data: { id: RECIPIENT_ID, tokenId: RECIPIENT_ID, username: `u${RECIPIENT_ID}` } })
    const caw = await prisma.caw.create({
      data: { userId: USER_ID, cawonce: 30, content: 'post with a tip', action: 'CAW', status: 'PENDING' },
    })
    const tip = await prisma.tip.create({
      data: { senderId: USER_ID, recipientId: RECIPIENT_ID, amount: 5, cawId: caw.id, cawonce: 30, pending: true },
    })

    await cancelPendingCaw(USER_ID, 30)

    await expectFailedNotDeleted(30)
    const tipAfter = await prisma.tip.findUnique({ where: { id: tip.id } })
    expect(tipAfter, 'the pending tip is left for cleanupPendingTips').to.exist
    expect(tipAfter!.cawId, 'and still points at the caw').to.equal(caw.id)
  })
})

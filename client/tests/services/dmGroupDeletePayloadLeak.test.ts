/**
 * Regression test for NEW-75: deleting a group-DM message "for everyone"
 * did not remove its per-recipient ciphertexts (MessageRecipientPayload
 * rows), and the read path returned them anyway without checking
 * contentType === 'deleted'. Together this meant a "deleted" group
 * message's plaintext-decryptable ciphertext kept coming back from the
 * API to every group member, even though the UI showed it as removed.
 *
 * This test does not go through the HTTP route (which needs signature
 * verification, rate limiting, etc.) — it exercises the same two things
 * the route/service actually do:
 *
 * 1. The fixed tombstone transaction (mirrors dm.ts's DELETE handler):
 *    deleteMany on MessageRecipientPayload + message.update in a single
 *    $transaction. Verifies the recipient payloads are actually gone from
 *    the DB afterward, not just nulled on the Message row.
 *
 * 2. The fixed read-side guard in DmService.getMessages and
 *    getConversations: even if a stale MessageRecipientPayload row exists
 *    (simulating a race, or data written before this fix shipped), a
 *    tombstoned message (contentType === 'deleted') must never surface
 *    that ciphertext through either read path.
 *
 * SKIPS unless DATABASE_URL points at a caw_test_* database. Example
 * (from client/):
 *
 *   DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/caw_test_dmleak \
 *   npx mocha --import=tsx --exit tests/services/dmGroupDeletePayloadLeak.test.ts
 *
 * The schema has to exist in that database (the project's usual schema setup).
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'

const HAS_TEST_DB = /\/caw_test_[A-Za-z0-9_]*(\?|$)/.test(process.env.DATABASE_URL ?? '')

const BASE = 990400
const SENDER_TOKEN_ID = BASE
const MEMBER_TOKEN_ID = BASE + 1
const OTHER_MEMBER_TOKEN_ID = BASE + 2

;(HAS_TEST_DB ? describe : describe.skip)('group DM "delete for everyone" removes recipient ciphertexts and never re-surfaces them', function () {
  this.timeout(30000)

  // Bound in `before` via dynamic import (see header).
  let prisma: typeof import('../../src/prismaClient').prisma
  let dmService: typeof import('../../src/services/DmService').default

  let conversationId = ''
  let messageId = ''

  before(async () => {
    ;({ prisma } = await import('../../src/prismaClient'))
    ;({ default: dmService } = await import('../../src/services/DmService'))

    for (const tokenId of [SENDER_TOKEN_ID, MEMBER_TOKEN_ID, OTHER_MEMBER_TOKEN_ID]) {
      await prisma.user.create({
        data: { id: tokenId, tokenId, username: `dmleak_test_${tokenId}`, address: `0x${tokenId.toString(16).padStart(40, '0')}` },
      })
      await prisma.dmIdentity.create({
        data: { userId: tokenId, walletAddress: `0x${tokenId.toString(16).padStart(40, '0')}`, publicKey: `pubkey_${tokenId}` },
      })
    }

    const conversation = await prisma.conversation.create({
      data: { type: 'GROUP', creatorId: SENDER_TOKEN_ID, name: 'dmleak test group' },
    })
    conversationId = conversation.id

    for (const tokenId of [SENDER_TOKEN_ID, MEMBER_TOKEN_ID, OTHER_MEMBER_TOKEN_ID]) {
      await prisma.conversationParticipant.create({
        data: { conversationId, userId: tokenId },
      })
    }

    const message = await prisma.message.create({
      data: {
        conversationId,
        senderId: SENDER_TOKEN_ID,
        contentType: 'text',
      },
    })
    messageId = message.id

    await prisma.messageRecipientPayload.createMany({
      data: [
        { messageId, recipientUserId: MEMBER_TOKEN_ID, encryptedPayload: 'ciphertext_for_member' },
        { messageId, recipientUserId: OTHER_MEMBER_TOKEN_ID, encryptedPayload: 'ciphertext_for_other_member' },
      ],
    })

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: message.createdAt, lastMessageId: messageId },
    })
  })

  after(async () => {
    await prisma.messageRecipientPayload.deleteMany({ where: { messageId } })
    await prisma.message.deleteMany({ where: { conversationId } })
    await prisma.conversationParticipant.deleteMany({ where: { conversationId } })
    await prisma.conversation.deleteMany({ where: { id: conversationId } })
    await prisma.dmIdentity.deleteMany({ where: { userId: { in: [SENDER_TOKEN_ID, MEMBER_TOKEN_ID, OTHER_MEMBER_TOKEN_ID] } } })
    await prisma.user.deleteMany({ where: { tokenId: { in: [SENDER_TOKEN_ID, MEMBER_TOKEN_ID, OTHER_MEMBER_TOKEN_ID] } } })
    await prisma.$disconnect()
  })

  it('deleteMany-wipes MessageRecipientPayload rows when tombstoning (mirrors the fixed DELETE handler)', async () => {
    const before = await prisma.messageRecipientPayload.findMany({ where: { messageId } })
    expect(before).to.have.length(2)

    // Mirrors the fixed transaction in dm.ts's DELETE /messages/:messageId.
    await prisma.$transaction(async tx => {
      await tx.messageRecipientPayload.deleteMany({ where: { messageId } })
      await tx.message.update({
        where: { id: messageId },
        data: { encryptedPayload: null, editHistory: null, contentType: 'deleted' },
      })
    })

    const after = await prisma.messageRecipientPayload.findMany({ where: { messageId } })
    expect(after).to.have.length(0)
  })

  it('never re-surfaces ciphertext through getMessages or getConversations, even if a stale recipient payload row exists', async () => {
    // Simulate a leftover/racing row that predates this fix (or a future
    // race) to prove the read-side guard is real defense-in-depth, not
    // just relying on the deleteMany above having already run.
    await prisma.messageRecipientPayload.create({
      data: { messageId, recipientUserId: MEMBER_TOKEN_ID, encryptedPayload: 'stale_leftover_ciphertext' },
    })

    const { messages } = await dmService.getMessages(conversationId, MEMBER_TOKEN_ID)
    const tombstoned = messages.find((m: any) => m.id === messageId)
    expect(tombstoned).to.exist
    expect(tombstoned.contentType).to.equal('deleted')
    expect(tombstoned.encryptedPayload).to.equal(null)

    const { conversations } = await dmService.getConversations(MEMBER_TOKEN_ID)
    const convo = conversations.find((c: any) => c.id === conversationId)
    expect(convo).to.exist
    expect(convo.lastMessage.contentType).to.equal('deleted')
    expect(convo.lastMessage.encryptedPayload).to.equal(null)

    await prisma.messageRecipientPayload.deleteMany({ where: { messageId, recipientUserId: MEMBER_TOKEN_ID } })
  })
})

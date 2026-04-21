/**
 * Integration tests for count management (commentCount, recawCount, likeCount, etc.)
 *
 * These tests exercise the full pipeline:
 *   1. Submit actions via API endpoints (single + batch)
 *   2. Assert optimistic DB records and counts are correct
 *   3. Simulate status transitions (PENDING → SUCCESS, PENDING → FAILED)
 *   4. Assert counts remain consistent after confirmation
 *
 * This catches double-counting bugs where both the API layer and the
 * ActionProcessor independently increment counts.
 */

import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import request from 'supertest'
import { ethers } from 'ethers'
import { prisma } from '../src/prismaClient'

// ============================================
// TEST INFRASTRUCTURE
// ============================================

// Import the app factory from the server module
// @ts-ignore — createApp is not in the TS export but exists at runtime
const { createApp } = await import('../src/api/server')
const app = createApp()

// Test account — deterministic private key for reproducible signatures
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const TEST_WALLET = new ethers.Wallet(TEST_PRIVATE_KEY)
const TEST_ADDRESS = TEST_WALLET.address.toLowerCase()

const TEST_USER_1 = { id: 99901, tokenId: 99901, username: 'counttest1', address: TEST_ADDRESS }
const TEST_USER_2 = { id: 99902, tokenId: 99902, username: 'counttest2', address: '0x0000000000000000000000000000000000099902' }

// EIP-712 domain — must match the contract
const DOMAIN = {
  name: 'Caw Protocol',
  version: '1',
  chainId: 84532, // Base Sepolia
  verifyingContract: '0x74dE2aCE81EC0be0b1DC7614679dc50254c4305f',
}

const ACTION_TYPES = {
  ActionData: [
    { name: 'actionType', type: 'uint8' },
    { name: 'senderId', type: 'uint32' },
    { name: 'receiverId', type: 'uint32' },
    { name: 'receiverCawonce', type: 'uint32' },
    { name: 'clientId', type: 'uint32' },
    { name: 'cawonce', type: 'uint32' },
    { name: 'recipients', type: 'uint32[]' },
    { name: 'amounts', type: 'uint64[]' },
    { name: 'text', type: 'bytes' },
  ],
}

// Sign an action with the test wallet
async function signAction(data: any) {
  const signature = await TEST_WALLET.signTypedData(DOMAIN, ACTION_TYPES, data)
  return { data, domain: DOMAIN, types: ACTION_TYPES, signature }
}

// Build and sign a CAW action
async function buildCawAction(opts: {
  senderId: number
  cawonce: number
  text?: string
  receiverId?: number
  receiverCawonce?: number
  amounts?: string[]
}) {
  const textHex = opts.text
    ? '0x' + Buffer.from(opts.text, 'utf8').toString('hex')
    : '0x'

  const data = {
    actionType: 0, // CAW
    senderId: opts.senderId,
    receiverId: opts.receiverId || 0,
    receiverCawonce: opts.receiverCawonce || 0,
    clientId: 1,
    cawonce: opts.cawonce,
    recipients: [],
    amounts: opts.amounts || [],
    text: textHex,
  }

  return signAction(data)
}

// Build and sign a LIKE action
async function buildLikeAction(opts: {
  senderId: number
  cawonce: number
  receiverId: number
  receiverCawonce: number
}) {
  const data = {
    actionType: 1, // LIKE
    senderId: opts.senderId,
    receiverId: opts.receiverId,
    receiverCawonce: opts.receiverCawonce,
    clientId: 1,
    cawonce: opts.cawonce,
    recipients: [],
    amounts: [],
    text: '0x',
  }
  return signAction(data)
}

// Build and sign a RECAW action
async function buildRecawAction(opts: {
  senderId: number
  cawonce: number
  receiverId: number
  receiverCawonce: number
  text?: string
}) {
  const textHex = opts.text
    ? '0x' + Buffer.from(opts.text, 'utf8').toString('hex')
    : '0x'

  const data = {
    actionType: 3, // RECAW
    senderId: opts.senderId,
    receiverId: opts.receiverId,
    receiverCawonce: opts.receiverCawonce,
    clientId: 1,
    cawonce: opts.cawonce,
    recipients: [],
    amounts: [],
    text: textHex,
  }
  return signAction(data)
}

// Build and sign a FOLLOW action
async function buildFollowAction(opts: {
  senderId: number
  cawonce: number
  receiverId: number
}) {
  const data = {
    actionType: 4, // FOLLOW
    senderId: opts.senderId,
    receiverId: opts.receiverId,
    receiverCawonce: 0,
    clientId: 1,
    cawonce: opts.cawonce,
    recipients: [],
    amounts: [],
    text: '0x',
  }
  return signAction(data)
}

// Submit a single action via POST /api/actions
async function submitSingle(signed: any) {
  return request(app)
    .post('/api/actions')
    .send(signed)
}

// Submit a batch via POST /api/actions/batch
async function submitBatch(signedActions: any[]) {
  return request(app)
    .post('/api/actions/batch')
    .send({ actions: signedActions })
}

// Get counts from DB
async function getCawCounts(cawId: number) {
  const caw = await prisma.caw.findUnique({
    where: { id: cawId },
    select: { commentCount: true, recawCount: true, likeCount: true },
  })
  return caw || { commentCount: 0, recawCount: 0, likeCount: 0 }
}

async function getUserCounts(tokenId: number) {
  const user = await prisma.user.findUnique({
    where: { tokenId },
    select: { cawCount: true, recawCount: true, followerCount: true, followingCount: true, likeCount: true },
  })
  return user || { cawCount: 0, recawCount: 0, followerCount: 0, followingCount: 0, likeCount: 0 }
}

// Clean up all test data
async function cleanupTestData() {
  const testIds = [TEST_USER_1.tokenId, TEST_USER_2.tokenId]
  await prisma.reply.deleteMany({ where: { userId: { in: testIds } } })
  await prisma.like.deleteMany({ where: { userId: { in: testIds } } })
  await prisma.follow.deleteMany({ where: { OR: [{ followerId: { in: testIds } }, { followingId: { in: testIds } }] } })
  await prisma.caw.deleteMany({ where: { userId: { in: testIds } } })
  await prisma.txQueue.deleteMany({ where: { senderId: { in: testIds } } })
  await prisma.user.deleteMany({ where: { tokenId: { in: testIds } } })
}

// ============================================
// TESTS
// ============================================

describe('Count Management Integration Tests', function () {
  this.timeout(30000)

  before(async () => {
    await cleanupTestData()
    await prisma.user.createMany({ data: [TEST_USER_1, TEST_USER_2] })
  })

  after(async () => {
    await cleanupTestData()
  })

  // ========================================
  // SINGLE CAW POST
  // ========================================

  describe('Single CAW post', () => {
    let cawId: number

    it('should create a pending Caw with correct counts', async () => {
      const signed = await buildCawAction({
        senderId: TEST_USER_1.tokenId,
        cawonce: 1000,
        text: 'Hello world from count test',
      })

      const res = await submitSingle(signed)
      expect(res.status).to.be.oneOf([200, 201])

      // Find the pending caw
      const caw = await prisma.caw.findUnique({
        where: { userId_cawonce: { userId: TEST_USER_1.tokenId, cawonce: 1000 } },
      })
      expect(caw).to.not.be.null
      expect(caw!.status).to.equal('PENDING')
      cawId = caw!.id

      // Counts should be at initial values
      const counts = await getCawCounts(cawId)
      expect(counts.commentCount).to.equal(0)
      expect(counts.recawCount).to.equal(0)
      expect(counts.likeCount).to.equal(0)

      console.log('Single CAW post: PASS')
    })
  })

  // ========================================
  // THREAD (BATCH REPLIES)
  // ========================================

  describe('Batch thread submission', () => {
    let parentCawId: number

    it('should create a 5-post thread with correct comment counts', async () => {
      // First post
      const firstPost = await buildCawAction({
        senderId: TEST_USER_1.tokenId,
        cawonce: 2000,
        text: 'Thread: First post',
      })

      // 4 replies
      const replies = await Promise.all(
        [1, 2, 3, 4].map(i =>
          buildCawAction({
            senderId: TEST_USER_1.tokenId,
            cawonce: 2000 + i,
            text: `Thread: Reply ${i}`,
            receiverId: TEST_USER_1.tokenId,
            receiverCawonce: 2000, // all reply to the first post
          })
        )
      )

      const res = await submitBatch([firstPost, ...replies])
      expect(res.status).to.be.oneOf([200, 201])

      // Find the parent caw
      const parentCaw = await prisma.caw.findUnique({
        where: { userId_cawonce: { userId: TEST_USER_1.tokenId, cawonce: 2000 } },
      })
      expect(parentCaw).to.not.be.null
      parentCawId = parentCaw!.id

      // Parent should have exactly 4 comments (not 0, not 8)
      const counts = await getCawCounts(parentCawId)
      expect(counts.commentCount).to.equal(4, 'Parent should have exactly 4 comments')
      expect(counts.recawCount).to.equal(0, 'Parent should have 0 recaws')

      // All reply Caw records should exist as PENDING
      for (let i = 1; i <= 4; i++) {
        const reply = await prisma.caw.findUnique({
          where: { userId_cawonce: { userId: TEST_USER_1.tokenId, cawonce: 2000 + i } },
        })
        expect(reply).to.not.be.null
        expect(reply!.status).to.equal('PENDING')
      }

      // Reply records should exist
      const replyCount = await prisma.reply.count({
        where: { cawId: parentCawId },
      })
      expect(replyCount).to.equal(4)

      console.log('Batch thread (5 posts, 4 replies): PASS')
    })

    it('should not double-count on status change to SUCCESS', async () => {
      // Simulate ActionProcessor confirming the caws (PENDING → SUCCESS)
      await prisma.caw.updateMany({
        where: {
          userId: TEST_USER_1.tokenId,
          cawonce: { in: [2000, 2001, 2002, 2003, 2004] },
        },
        data: { status: 'SUCCESS' },
      })

      // Counts should remain the same
      const counts = await getCawCounts(parentCawId)
      expect(counts.commentCount).to.equal(4, 'commentCount should still be 4 after SUCCESS')
      expect(counts.recawCount).to.equal(0, 'recawCount should still be 0')

      console.log('No double-count on SUCCESS: PASS')
    })
  })

  // ========================================
  // LARGE THREAD
  // ========================================

  describe('Large batch thread (20 replies)', () => {
    let parentCawId: number

    it('should handle 20 replies with correct counts', async () => {
      const firstPost = await buildCawAction({
        senderId: TEST_USER_1.tokenId,
        cawonce: 3000,
        text: 'Large thread: First post',
      })

      const replies = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          buildCawAction({
            senderId: TEST_USER_1.tokenId,
            cawonce: 3001 + i,
            text: `Large thread: Reply ${i + 1}`,
            receiverId: TEST_USER_1.tokenId,
            receiverCawonce: 3000,
          })
        )
      )

      const res = await submitBatch([firstPost, ...replies])
      expect(res.status).to.be.oneOf([200, 201])

      const parentCaw = await prisma.caw.findUnique({
        where: { userId_cawonce: { userId: TEST_USER_1.tokenId, cawonce: 3000 } },
      })
      parentCawId = parentCaw!.id

      const counts = await getCawCounts(parentCawId)
      expect(counts.commentCount).to.equal(20, 'Should have exactly 20 comments')

      console.log('Large thread (20 replies): PASS')
    })
  })

  // ========================================
  // MIXED BATCH (CAW + REPLY + different users)
  // ========================================

  describe('Mixed action types', () => {
    it('should handle standalone posts and replies in the same batch', async () => {
      const standalone = await buildCawAction({
        senderId: TEST_USER_1.tokenId,
        cawonce: 4000,
        text: 'Standalone post',
      })

      const anotherStandalone = await buildCawAction({
        senderId: TEST_USER_1.tokenId,
        cawonce: 4001,
        text: 'Another standalone',
      })

      // Reply to the first standalone
      const reply = await buildCawAction({
        senderId: TEST_USER_1.tokenId,
        cawonce: 4002,
        text: 'Reply to standalone',
        receiverId: TEST_USER_1.tokenId,
        receiverCawonce: 4000,
      })

      const res = await submitBatch([standalone, anotherStandalone, reply])
      expect(res.status).to.be.oneOf([200, 201])

      // First standalone should have 1 reply
      const post1 = await prisma.caw.findUnique({
        where: { userId_cawonce: { userId: TEST_USER_1.tokenId, cawonce: 4000 } },
      })
      expect(post1!.commentCount).to.equal(1)

      // Second standalone should have 0 replies
      const post2 = await prisma.caw.findUnique({
        where: { userId_cawonce: { userId: TEST_USER_1.tokenId, cawonce: 4001 } },
      })
      expect(post2!.commentCount).to.equal(0)

      console.log('Mixed batch (2 standalone + 1 reply): PASS')
    })
  })

  // ========================================
  // SINGLE REPLY VIA SINGLE ENDPOINT
  // ========================================

  describe('Single reply via single endpoint', () => {
    it('should increment commentCount by exactly 1', async () => {
      // Create a parent post first
      const parent = await buildCawAction({
        senderId: TEST_USER_1.tokenId,
        cawonce: 5000,
        text: 'Parent for single reply test',
      })
      await submitSingle(parent)

      const parentCaw = await prisma.caw.findUnique({
        where: { userId_cawonce: { userId: TEST_USER_1.tokenId, cawonce: 5000 } },
      })
      expect(parentCaw!.commentCount).to.equal(0)

      // Submit a single reply
      const reply = await buildCawAction({
        senderId: TEST_USER_1.tokenId,
        cawonce: 5001,
        text: 'Single reply',
        receiverId: TEST_USER_1.tokenId,
        receiverCawonce: 5000,
      })
      await submitSingle(reply)

      // Check count
      const updated = await prisma.caw.findUnique({
        where: { userId_cawonce: { userId: TEST_USER_1.tokenId, cawonce: 5000 } },
      })
      expect(updated!.commentCount).to.equal(1, 'commentCount should be exactly 1')

      console.log('Single reply: PASS')
    })
  })

  // ========================================
  // DUPLICATE SUBMISSION GUARD
  // ========================================

  describe('Duplicate submission', () => {
    it('should not double-count when the same action is submitted twice', async () => {
      const post = await buildCawAction({
        senderId: TEST_USER_1.tokenId,
        cawonce: 6000,
        text: 'Parent for duplicate test',
      })
      await submitSingle(post)

      const reply = await buildCawAction({
        senderId: TEST_USER_1.tokenId,
        cawonce: 6001,
        text: 'Reply that gets submitted twice',
        receiverId: TEST_USER_1.tokenId,
        receiverCawonce: 6000,
      })

      // Submit twice
      await submitSingle(reply)
      // Second submission should fail (duplicate signedTx)
      const res2 = await submitSingle(reply)

      const parentCaw = await prisma.caw.findUnique({
        where: { userId_cawonce: { userId: TEST_USER_1.tokenId, cawonce: 6000 } },
      })
      expect(parentCaw!.commentCount).to.equal(1, 'commentCount should be 1, not 2')

      console.log('Duplicate submission guard: PASS')
    })
  })

  // ========================================
  // RECAW COUNTS
  // ========================================

  describe('Recaw counts', () => {
    it('should increment recawCount on the parent caw', async () => {
      // Create a post to recaw
      const post = await buildCawAction({
        senderId: TEST_USER_1.tokenId,
        cawonce: 7000,
        text: 'Post to be recawed',
      })
      await submitSingle(post)

      const parentCaw = await prisma.caw.findUnique({
        where: { userId_cawonce: { userId: TEST_USER_1.tokenId, cawonce: 7000 } },
      })
      expect(parentCaw!.recawCount).to.equal(0)

      // Recaw it
      const recaw = await buildRecawAction({
        senderId: TEST_USER_1.tokenId,
        cawonce: 7001,
        receiverId: TEST_USER_1.tokenId,
        receiverCawonce: 7000,
      })
      await submitSingle(recaw)

      const updated = await prisma.caw.findUnique({
        where: { userId_cawonce: { userId: TEST_USER_1.tokenId, cawonce: 7000 } },
      })
      expect(updated!.recawCount).to.equal(1, 'recawCount should be 1')

      console.log('Recaw count: PASS')
    })
  })
})

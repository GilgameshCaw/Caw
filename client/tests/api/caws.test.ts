import { expect } from 'chai'
import request from 'supertest'
import { Express } from 'express'
import {
  createTestApp,
  cleanDatabase,
  createTestUser,
  createTestCaw,
  prisma
} from '../helpers/test-setup'

describe('/api/caws', () => {
  let app: Express
  let testUser: any
  let testCaw: any

  before(() => {
    app = createTestApp()
  })

  beforeEach(async () => {
    await cleanDatabase()
    testUser = await createTestUser()
    testCaw = await createTestCaw(testUser.id)
  })

  afterEach(async () => {
    await cleanDatabase()
  })

  after(async () => {
    await prisma.$disconnect()
  })

  describe('GET /api/caws', () => {
    it('should return list of caws', async () => {
      // Create multiple caws
      await createTestCaw(testUser.id, { content: 'Caw 1' })
      await createTestCaw(testUser.id, { content: 'Caw 2' })
      await createTestCaw(testUser.id, { content: 'Caw 3' })

      const res = await request(app)
        .get('/api/caws')
        .expect(200)

      expect(res.body).to.have.property('caws')
      expect(res.body.caws).to.be.an('array')
      expect(res.body.caws.length).to.be.at.least(3)
    })

    it('should support pagination', async () => {
      // Create 25 caws
      for (let i = 0; i < 25; i++) {
        await createTestCaw(testUser.id, { content: `Caw ${i}` })
      }

      const res = await request(app)
        .get('/api/caws?limit=10&offset=0')
        .expect(200)

      expect(res.body.caws).to.have.lengthOf(10)
      expect(res.body).to.have.property('nextCursor')
    })

    it('should filter by user', async () => {
      const otherUser = await createTestUser()
      await createTestCaw(otherUser.id, { content: 'Other user caw' })

      const res = await request(app)
        .get(`/api/caws?userId=${testUser.id}`)
        .expect(200)

      res.body.caws.forEach((caw: any) => {
        expect(caw.userId).to.equal(testUser.id)
      })
    })

    it('should filter replies', async () => {
      const replyCaw = await createTestCaw(testUser.id, {
        content: 'Reply',
        isReply: true,
        replyToId: testCaw.id
      })

      const res = await request(app)
        .get('/api/caws?excludeReplies=true')
        .expect(200)

      const hasReply = res.body.caws.some((caw: any) => caw.isReply === true)
      expect(hasReply).to.be.false
    })
  })

  describe('GET /api/caws/:id', () => {
    it('should return a single caw', async () => {
      const res = await request(app)
        .get(`/api/caws/${testCaw.id}`)
        .expect(200)

      expect(res.body).to.have.property('id', testCaw.id)
      expect(res.body).to.have.property('content', testCaw.content)
      expect(res.body).to.have.property('user')
    })

    it('should return 404 for non-existent caw', async () => {
      const res = await request(app)
        .get('/api/caws/999999')
        .expect(404)

      expect(res.body).to.have.property('error')
    })

    it('should include user details', async () => {
      const res = await request(app)
        .get(`/api/caws/${testCaw.id}`)
        .expect(200)

      expect(res.body.user).to.have.property('id', testUser.id)
      expect(res.body.user).to.have.property('username', testUser.username)
    })
  })

  describe('GET /api/caws/:id/replies', () => {
    it('should return replies for a caw', async () => {
      // Create replies
      await createTestCaw(testUser.id, {
        content: 'Reply 1',
        isReply: true,
        replyToId: testCaw.id
      })
      await createTestCaw(testUser.id, {
        content: 'Reply 2',
        isReply: true,
        replyToId: testCaw.id
      })

      const res = await request(app)
        .get(`/api/caws/${testCaw.id}/replies`)
        .expect(200)

      expect(res.body).to.have.property('items')
      expect(res.body.items).to.be.an('array')
      expect(res.body.items).to.have.lengthOf(2)
      res.body.items.forEach((reply: any) => {
        expect(reply.replyToId).to.equal(testCaw.id)
      })
    })

    it('should support pagination for replies', async () => {
      // Create 15 replies
      for (let i = 0; i < 15; i++) {
        await createTestCaw(testUser.id, {
          content: `Reply ${i}`,
          isReply: true,
          replyToId: testCaw.id
        })
      }

      const res = await request(app)
        .get(`/api/caws/${testCaw.id}/replies?limit=5`)
        .expect(200)

      expect(res.body.items).to.have.lengthOf(5)
      expect(res.body).to.have.property('nextCursor')
    })
  })

  describe('GET /api/caws/thread/:id', () => {
    it('should return thread with parent and replies', async () => {
      // Create a thread: parent -> testCaw -> reply
      const parentCaw = await createTestCaw(testUser.id, { content: 'Parent' })
      await prisma.caw.update({
        where: { id: testCaw.id },
        data: {
          isReply: true,
          replyToId: parentCaw.id
        }
      })
      const replyCaw = await createTestCaw(testUser.id, {
        content: 'Reply',
        isReply: true,
        replyToId: testCaw.id
      })

      const res = await request(app)
        .get(`/api/caws/thread/${testCaw.id}`)
        .expect(200)

      expect(res.body).to.have.property('parents')
      expect(res.body).to.have.property('mainCaw')
      expect(res.body).to.have.property('replies')
      expect(res.body.parents).to.have.lengthOf(1)
      expect(res.body.mainCaw.id).to.equal(testCaw.id)
      expect(res.body.replies.items).to.have.lengthOf(1)
    })
  })

  describe('GET /api/caws/quotes/:id', () => {
    it('should return quotes of a caw', async () => {
      // Create quotes
      await createTestCaw(testUser.id, {
        content: 'Quote 1',
        isQuote: true,
        quoteOfId: testCaw.id
      })
      await createTestCaw(testUser.id, {
        content: 'Quote 2',
        isQuote: true,
        quoteOfId: testCaw.id
      })

      const res = await request(app)
        .get(`/api/caws/quotes/${testCaw.id}`)
        .expect(200)

      expect(res.body).to.have.property('items')
      expect(res.body.items).to.have.lengthOf(2)
      res.body.items.forEach((quote: any) => {
        expect(quote.quoteOfId).to.equal(testCaw.id)
      })
    })
  })

  describe('GET /api/caws/recaws/:id', () => {
    it('should return recaws of a caw', async () => {
      const otherUser = await createTestUser()

      // Create recaws
      await createTestCaw(otherUser.id, {
        isRecaw: true,
        recawOfId: testCaw.id
      })

      const res = await request(app)
        .get(`/api/caws/recaws/${testCaw.id}`)
        .expect(200)

      expect(res.body).to.have.property('items')
      expect(res.body.items).to.be.an('array')
      res.body.items.forEach((recaw: any) => {
        expect(recaw.recawOfId).to.equal(testCaw.id)
      })
    })
  })

  describe('Error handling', () => {
    it('should handle database errors gracefully', async () => {
      // Test with invalid ID format
      const res = await request(app)
        .get('/api/caws/invalid-id')
        .expect(400)

      expect(res.body).to.have.property('error')
    })

    it('should validate query parameters', async () => {
      const res = await request(app)
        .get('/api/caws?limit=1000') // Too high limit
        .expect(200)

      // Should cap at max limit
      expect(res.body.caws.length).to.be.at.most(100)
    })
  })
})
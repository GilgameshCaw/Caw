import { expect } from 'chai'
import request from 'supertest'
import { Express } from 'express'
import {
  createTestApp,
  cleanDatabase,
  createTestUser,
  createTestCaw,
  createTestBookmark,
  prisma
} from '../helpers/test-setup'

describe('/api/bookmarks', () => {
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

  describe('GET /api/bookmarks', () => {
    it('should return empty array when no bookmarks', async () => {
      const res = await request(app)
        .get('/api/bookmarks')
        .set('x-user-id', testUser.tokenId.toString())
        .expect(200)

      expect(res.body).to.have.property('items')
      expect(res.body.items).to.be.an('array')
      expect(res.body.items).to.have.lengthOf(0)
    })

    it('should require authentication', async () => {
      await request(app)
        .get('/api/bookmarks')
        .expect(401)
    })

    it('should return user bookmarks', async () => {
      // Create bookmarks
      const caw1 = await createTestCaw(testUser.id, { content: 'Bookmarked 1' })
      const caw2 = await createTestCaw(testUser.id, { content: 'Bookmarked 2' })
      await createTestBookmark(testUser.id, caw1.id)
      await createTestBookmark(testUser.id, caw2.id)

      const res = await request(app)
        .get('/api/bookmarks')
        .set('x-user-id', testUser.tokenId.toString())
        .expect(200)

      expect(res.body.items).to.have.lengthOf(2)
      expect(res.body.items[0]).to.have.property('isBookmarked', true)
    })

    it('should support pagination', async () => {
      // Create 15 bookmarks
      for (let i = 0; i < 15; i++) {
        const caw = await createTestCaw(testUser.id, { content: `Caw ${i}` })
        await createTestBookmark(testUser.id, caw.id)
      }

      const res = await request(app)
        .get('/api/bookmarks?limit=5')
        .set('x-user-id', testUser.tokenId.toString())
        .expect(200)

      expect(res.body.items).to.have.lengthOf(5)
      expect(res.body).to.have.property('nextCursor')
    })
  })

  describe('POST /api/bookmarks/:cawId', () => {
    it('should create a bookmark', async () => {
      const res = await request(app)
        .post(`/api/bookmarks/${testCaw.id}`)
        .set('x-user-id', testUser.tokenId.toString())
        .send({})
        .expect(200)

      expect(res.body).to.have.property('success', true)

      // Verify bookmark was created
      const bookmark = await prisma.bookmark.findFirst({
        where: { userId: testUser.id, cawId: testCaw.id }
      })
      expect(bookmark).to.not.be.null
    })

    it('should require authentication', async () => {
      await request(app)
        .post(`/api/bookmarks/${testCaw.id}`)
        .send({})
        .expect(401)
    })

    it('should handle duplicate bookmarks', async () => {
      // Create initial bookmark
      await createTestBookmark(testUser.id, testCaw.id)

      // Try to create duplicate
      const res = await request(app)
        .post(`/api/bookmarks/${testCaw.id}`)
        .set('x-user-id', testUser.tokenId.toString())
        .send({})
        .expect(200)

      expect(res.body).to.have.property('success', true)
    })

    it('should return 404 for non-existent caw', async () => {
      await request(app)
        .post('/api/bookmarks/999999')
        .set('x-user-id', testUser.tokenId.toString())
        .send({})
        .expect(404)
    })
  })

  describe('DELETE /api/bookmarks/:cawId', () => {
    it('should remove a bookmark', async () => {
      // Create bookmark
      await createTestBookmark(testUser.id, testCaw.id)

      const res = await request(app)
        .delete(`/api/bookmarks/${testCaw.id}`)
        .set('x-user-id', testUser.tokenId.toString())
        .expect(200)

      expect(res.body).to.have.property('success', true)

      // Verify bookmark was removed
      const bookmark = await prisma.bookmark.findFirst({
        where: { userId: testUser.id, cawId: testCaw.id }
      })
      expect(bookmark).to.be.null
    })

    it('should require authentication', async () => {
      await request(app)
        .delete(`/api/bookmarks/${testCaw.id}`)
        .expect(401)
    })

    it('should handle non-existent bookmark', async () => {
      const res = await request(app)
        .delete(`/api/bookmarks/${testCaw.id}`)
        .set('x-user-id', testUser.tokenId.toString())
        .expect(200)

      expect(res.body).to.have.property('success', true)
    })
  })
})
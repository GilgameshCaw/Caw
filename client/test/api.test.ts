import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'
import request from 'supertest'
import express from 'express'
import { prisma } from '../src/prismaClient'
import { setupApiRoutes } from '../src/api/server'

// Create test app
const app = express()
app.use(express.json())
setupApiRoutes(app)

// Test data
const testUser1 = { tokenId: 9991, username: 'testuser1', displayName: 'Test User 1' }
const testUser2 = { tokenId: 9992, username: 'testuser2', displayName: 'Test User 2' }

describe('API Endpoints', () => {
  // Clean up test data before and after tests
  before(async () => {
    await cleanupTestData()
    await setupTestData()
  })

  after(async () => {
    await cleanupTestData()
  })

  describe('GET /api/caws', () => {
    it('should return caws with pagination', async () => {
      const res = await request(app)
        .get('/api/caws')
        .expect(200)

      expect(res.body).to.have.property('items')
      expect(res.body.items).to.be.an('array')
      expect(res.body).to.have.property('nextCursor')
    })

    it('should filter by following when filter=following', async () => {
      const res = await request(app)
        .get('/api/caws?filter=following')
        .set('x-user-id', testUser1.tokenId.toString())
        .expect(200)

      expect(res.body.items).to.be.an('array')
    })

    it('should return user caws when userId is provided', async () => {
      const res = await request(app)
        .get(`/api/caws?userId=${testUser1.tokenId}`)
        .expect(200)

      expect(res.body.items).to.be.an('array')
      res.body.items.forEach((caw: any) => {
        expect(caw.user.tokenId).to.equal(testUser1.tokenId)
      })
    })

    it('should respect limit parameter', async () => {
      const limit = 5
      const res = await request(app)
        .get(`/api/caws?limit=${limit}`)
        .expect(200)

      expect(res.body.items.length).to.be.at.most(limit)
    })
  })

  describe('GET /api/caws/:id', () => {
    let testCawId: number

    before(async () => {
      const caw = await prisma.caw.create({
        data: {
          userId: testUser1.tokenId,
          content: 'Test caw for detail view',
          action: 'CAW',
          cawonce: 999
        }
      })
      testCawId = caw.id
    })

    it('should return caw details with comments', async () => {
      const res = await request(app)
        .get(`/api/caws/${testCawId}`)
        .expect(200)

      expect(res.body).to.have.property('caw')
      expect(res.body).to.have.property('comments')
      expect(res.body.caw.id).to.equal(testCawId.toString())
      expect(res.body.comments).to.be.an('array')
    })

    it('should return 404 for non-existent caw', async () => {
      await request(app)
        .get('/api/caws/99999999')
        .expect(404)
    })
  })

  describe('GET /api/users/:id', () => {
    it('should return user profile', async () => {
      const res = await request(app)
        .get(`/api/users/${testUser1.tokenId}`)
        .expect(200)

      expect(res.body).to.have.property('user')
      expect(res.body.user.tokenId).to.equal(testUser1.tokenId)
      expect(res.body.user.username).to.equal(testUser1.username)
      expect(res.body.user).to.have.property('followerCount')
      expect(res.body.user).to.have.property('followingCount')
      expect(res.body.user).to.have.property('likeCount')
    })

    it('should return 404 for non-existent user', async () => {
      await request(app)
        .get('/api/users/99999999')
        .expect(404)
    })

    it('should indicate following status when x-user-id header is present', async () => {
      const res = await request(app)
        .get(`/api/users/${testUser2.tokenId}`)
        .set('x-user-id', testUser1.tokenId.toString())
        .expect(200)

      expect(res.body.user).to.have.property('isFollowing')
      expect(res.body.user.isFollowing).to.be.a('boolean')
    })
  })

  describe('POST /api/actions', () => {
    it('should queue new action with valid signature', async () => {
      const actionData = {
        data: {
          actionType: 0, // CAW
          senderId: testUser1.tokenId,
          receiverId: 0,
          receiverCawonce: 0,
          clientId: 1,
          cawonce: 1000,
          recipients: [],
          amounts: ['100000'],
          text: 'Test caw from API test'
        },
        domain: {
          name: 'Caw Protocol',
          version: '1',
          chainId: 84532,
          verifyingContract: '0x793b884C8e64166d3faCDD03115F168Dbf539ae1'
        },
        types: {},
        signature: '0x' + '0'.repeat(130) // Mock signature for testing
      }

      const res = await request(app)
        .post('/api/actions')
        .send(actionData)
        .expect(201)

      expect(res.body).to.have.property('status', 'queued')
      expect(res.body).to.have.property('txQueueId')
    })

    it('should return 400 for missing required fields', async () => {
      const res = await request(app)
        .post('/api/actions')
        .send({})
        .expect(400)

      expect(res.body).to.have.property('error')
    })

    it('should create pending like when actionType is 1', async () => {
      const caw = await prisma.caw.create({
        data: {
          userId: testUser2.tokenId,
          content: 'Test caw to be liked',
          action: 'CAW',
          cawonce: 1001
        }
      })

      const actionData = {
        data: {
          actionType: 1, // LIKE
          senderId: testUser1.tokenId,
          receiverId: testUser2.tokenId,
          receiverCawonce: 1001,
          clientId: 1,
          cawonce: 1002,
          recipients: [],
          amounts: ['100000'],
          text: ''
        },
        domain: {
          name: 'Caw Protocol',
          version: '1',
          chainId: 84532,
          verifyingContract: '0x793b884C8e64166d3faCDD03115F168Dbf539ae1'
        },
        types: {},
        signature: '0x' + '0'.repeat(130)
      }

      await request(app)
        .post('/api/actions')
        .send(actionData)
        .expect(201)

      // Check if pending like was created
      const like = await prisma.like.findUnique({
        where: {
          userId_cawId: {
            userId: testUser1.tokenId,
            cawId: caw.id
          }
        }
      })

      expect(like).to.exist
      expect(like?.pending).to.be.true
      expect(like?.action).to.equal('LIKE')
    })
  })

  describe('GET /api/bookmarks', () => {
    before(async () => {
      // Create a bookmark for testing
      const caw = await prisma.caw.findFirst()
      if (caw) {
        await prisma.bookmark.create({
          data: {
            userId: testUser1.tokenId,
            cawId: caw.id
          }
        })
      }
    })

    it('should return user bookmarks', async () => {
      const res = await request(app)
        .get('/api/bookmarks')
        .set('x-user-id', testUser1.tokenId.toString())
        .expect(200)

      expect(res.body).to.have.property('items')
      expect(res.body.items).to.be.an('array')
    })

    it('should return 401 when user ID header is missing', async () => {
      await request(app)
        .get('/api/bookmarks')
        .expect(401)
    })
  })

  describe('POST /api/bookmarks/:cawId', () => {
    let testCawId: number

    before(async () => {
      const caw = await prisma.caw.create({
        data: {
          userId: testUser1.tokenId,
          content: 'Test caw for bookmarking',
          action: 'CAW',
          cawonce: 1003
        }
      })
      testCawId = caw.id
    })

    it('should create a bookmark', async () => {
      const res = await request(app)
        .post(`/api/bookmarks/${testCawId}`)
        .set('x-user-id', testUser1.tokenId.toString())
        .send({})
        .expect(201)

      expect(res.body).to.have.property('status', 'bookmarked')

      // Verify bookmark was created
      const bookmark = await prisma.bookmark.findUnique({
        where: {
          userId_cawId: {
            userId: testUser1.tokenId,
            cawId: testCawId
          }
        }
      })
      expect(bookmark).to.exist
    })

    it('should return 401 when user ID header is missing', async () => {
      await request(app)
        .post(`/api/bookmarks/${testCawId}`)
        .send({})
        .expect(401)
    })
  })

  describe('DELETE /api/bookmarks/:cawId', () => {
    let testCawId: number

    before(async () => {
      const caw = await prisma.caw.create({
        data: {
          userId: testUser1.tokenId,
          content: 'Test caw for bookmark deletion',
          action: 'CAW',
          cawonce: 1004
        }
      })
      testCawId = caw.id

      // Create bookmark to delete
      await prisma.bookmark.create({
        data: {
          userId: testUser1.tokenId,
          cawId: testCawId
        }
      })
    })

    it('should delete a bookmark', async () => {
      const res = await request(app)
        .delete(`/api/bookmarks/${testCawId}`)
        .set('x-user-id', testUser1.tokenId.toString())
        .expect(200)

      expect(res.body).to.have.property('status', 'unbookmarked')

      // Verify bookmark was deleted
      const bookmark = await prisma.bookmark.findUnique({
        where: {
          userId_cawId: {
            userId: testUser1.tokenId,
            cawId: testCawId
          }
        }
      })
      expect(bookmark).to.be.null
    })
  })

  describe('GET /api/search', () => {
    it('should search caws', async () => {
      const res = await request(app)
        .get('/api/search?q=test&type=caws')
        .expect(200)

      expect(res.body).to.have.property('caws')
      expect(res.body.caws).to.be.an('array')
    })

    it('should search users', async () => {
      const res = await request(app)
        .get('/api/search?q=test&type=users')
        .expect(200)

      expect(res.body).to.have.property('users')
      expect(res.body.users).to.be.an('array')
    })

    it('should search hashtags', async () => {
      const res = await request(app)
        .get('/api/search?q=test&type=hashtags')
        .expect(200)

      expect(res.body).to.have.property('hashtags')
      expect(res.body.hashtags).to.be.an('array')
    })

    it('should search all types when type=all', async () => {
      const res = await request(app)
        .get('/api/search?q=test&type=all')
        .expect(200)

      expect(res.body).to.have.property('caws')
      expect(res.body).to.have.property('users')
      expect(res.body).to.have.property('hashtags')
    })

    it('should return 400 for short query', async () => {
      await request(app)
        .get('/api/search?q=t')
        .expect(400)
    })
  })

  describe('GET /api/search/suggestions', () => {
    it('should return search suggestions', async () => {
      const res = await request(app)
        .get('/api/search/suggestions?q=test')
        .expect(200)

      expect(res.body).to.have.property('suggestions')
      expect(res.body.suggestions).to.be.an('array')
    })

    it('should return hashtag suggestions for # queries', async () => {
      const res = await request(app)
        .get('/api/search/suggestions?q=%23test')
        .expect(200)

      expect(res.body.suggestions).to.be.an('array')
      res.body.suggestions.forEach((s: any) => {
        if (s.type === 'hashtag') {
          expect(s.value).to.match(/^#/)
        }
      })
    })
  })

  describe('GET /api/search/trending', () => {
    it('should return trending hashtags and users', async () => {
      const res = await request(app)
        .get('/api/search/trending')
        .expect(200)

      expect(res.body).to.have.property('hashtags')
      expect(res.body).to.have.property('users')
      expect(res.body.hashtags).to.be.an('array')
      expect(res.body.users).to.be.an('array')
    })
  })

  describe('GET /api/hashtags/:tag', () => {
    before(async () => {
      // Create hashtag and associated caw
      await prisma.hashtag.create({
        data: { tag: 'testhashtag', usageCount: 1 }
      })
    })

    it('should return hashtag details with caws', async () => {
      const res = await request(app)
        .get('/api/hashtags/testhashtag')
        .expect(200)

      expect(res.body).to.have.property('hashtag')
      expect(res.body).to.have.property('caws')
      expect(res.body.hashtag.tag).to.equal('testhashtag')
      expect(res.body.caws).to.be.an('array')
    })

    it('should return 404 for non-existent hashtag', async () => {
      await request(app)
        .get('/api/hashtags/nonexistenthashtag')
        .expect(404)
    })
  })

  describe('GET /api/scheduled', () => {
    it('should return scheduled caws for user', async () => {
      const res = await request(app)
        .get('/api/scheduled')
        .set('x-user-id', testUser1.tokenId.toString())
        .expect(200)

      expect(res.body).to.have.property('items')
      expect(res.body.items).to.be.an('array')
    })

    it('should return 401 when user ID header is missing', async () => {
      await request(app)
        .get('/api/scheduled')
        .expect(401)
    })
  })

  describe('POST /api/scheduled', () => {
    it('should create a scheduled caw', async () => {
      const scheduledTime = new Date(Date.now() + 3600000) // 1 hour from now

      const res = await request(app)
        .post('/api/scheduled')
        .set('x-user-id', testUser1.tokenId.toString())
        .send({
          content: 'Scheduled test caw',
          scheduledAt: scheduledTime.toISOString()
        })
        .expect(201)

      expect(res.body).to.have.property('id')
      expect(res.body.content).to.equal('Scheduled test caw')
      expect(new Date(res.body.scheduledAt).getTime()).to.be.closeTo(scheduledTime.getTime(), 1000)
    })

    it('should return 400 for past scheduled time', async () => {
      const pastTime = new Date(Date.now() - 3600000) // 1 hour ago

      await request(app)
        .post('/api/scheduled')
        .set('x-user-id', testUser1.tokenId.toString())
        .send({
          content: 'Past scheduled caw',
          scheduledAt: pastTime.toISOString()
        })
        .expect(400)
    })
  })
})

// Helper functions
async function cleanupTestData() {
  // Clean up test data
  await prisma.like.deleteMany({
    where: { userId: { in: [testUser1.tokenId, testUser2.tokenId] } }
  })
  await prisma.bookmark.deleteMany({
    where: { userId: { in: [testUser1.tokenId, testUser2.tokenId] } }
  })
  await prisma.scheduledCaw.deleteMany({
    where: { userId: { in: [testUser1.tokenId, testUser2.tokenId] } }
  })
  await prisma.cawHashtag.deleteMany({})
  await prisma.hashtag.deleteMany({
    where: { tag: { startsWith: 'test' } }
  })
  await prisma.caw.deleteMany({
    where: { userId: { in: [testUser1.tokenId, testUser2.tokenId] } }
  })
  await prisma.follow.deleteMany({
    where: {
      OR: [
        { followerId: { in: [testUser1.tokenId, testUser2.tokenId] } },
        { followingId: { in: [testUser1.tokenId, testUser2.tokenId] } }
      ]
    }
  })
  await prisma.txQueue.deleteMany({
    where: { senderId: { in: [testUser1.tokenId, testUser2.tokenId] } }
  })
  await prisma.user.deleteMany({
    where: { tokenId: { in: [testUser1.tokenId, testUser2.tokenId] } }
  })
}

async function setupTestData() {
  // Create test users
  await prisma.user.createMany({
    data: [testUser1, testUser2]
  })

  // Create some test caws
  await prisma.caw.createMany({
    data: [
      {
        userId: testUser1.tokenId,
        content: 'Test caw 1',
        action: 'CAW',
        cawonce: 1
      },
      {
        userId: testUser1.tokenId,
        content: 'Test caw 2',
        action: 'CAW',
        cawonce: 2
      },
      {
        userId: testUser2.tokenId,
        content: 'Test caw from user 2',
        action: 'CAW',
        cawonce: 1
      }
    ]
  })

  // Create follow relationship
  await prisma.follow.create({
    data: {
      followerId: testUser1.tokenId,
      followingId: testUser2.tokenId,
      action: 'FOLLOW'
    }
  })
}
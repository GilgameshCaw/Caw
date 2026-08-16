// Tests for DataCleaner's Like/Follow rollback on stale pending purge.
//
// Integration-style: exercises CountManager.onStatusChanged through the
// same transaction pattern DataCleaner uses (deleteMany + count guard),
// against a real database. Requires DATABASE_URL to point at a disposable
// test database — never run against a live install.

process.env.CLIENT_ID = '1'

import { expect } from 'chai'
import { PrismaClient } from '@prisma/client'
import { countManager } from '../../../src/services/CountManager'

const prisma = new PrismaClient()

const LIKER_ID = 90001
const AUTHOR_ID = 90002
const CAW_ID = 90101
const FOLLOWER_ID = 90001
const TARGET_ID = 90002

async function resetFixtures() {
  await prisma.like.deleteMany({ where: { userId: { in: [LIKER_ID, AUTHOR_ID] } } })
  await prisma.follow.deleteMany({ where: { followerId: { in: [FOLLOWER_ID, TARGET_ID] } } })
  await prisma.caw.deleteMany({ where: { id: CAW_ID } })
  await prisma.user.deleteMany({ where: { id: { in: [LIKER_ID, AUTHOR_ID] } } })
}

async function seedUsers() {
  for (const id of [LIKER_ID, AUTHOR_ID]) {
    await prisma.user.upsert({
      where: { id },
      update: {},
      create: { id, tokenId: id, username: `dctest${id}` },
    })
  }
}

// Mirrors the exact transaction pattern applied in DataCleaner.cleanupPendingLikes.
async function runLikeCleanup(likeId: number) {
  return prisma.$transaction(async (tx) => {
    const deleted = await tx.like.deleteMany({
      where: { userId: LIKER_ID, cawId: CAW_ID, pending: true },
    })
    if (deleted.count > 0) {
      await countManager.onStatusChanged(tx as any, 'like', likeId, 'PENDING', 'FAILED', {
        cawId: CAW_ID, userId: LIKER_ID,
      })
    }
    return deleted.count
  })
}

// Mirrors the exact transaction pattern applied in DataCleaner.cleanupPendingFollows.
async function runFollowCleanup(followId: number) {
  return prisma.$transaction(async (tx) => {
    const deleted = await tx.follow.deleteMany({
      where: { followerId: FOLLOWER_ID, followingId: TARGET_ID, status: 'PENDING' },
    })
    if (deleted.count > 0) {
      await countManager.onStatusChanged(tx as any, 'follow', followId, 'PENDING', 'FAILED', {
        followerId: FOLLOWER_ID, followingId: TARGET_ID,
      })
    }
    return deleted.count
  })
}

describe('DataCleaner / stale pending like & follow rollback', () => {
  before(async () => {
    if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.includes('test')) {
      throw new Error(
        'DATABASE_URL must point at a disposable test database (name containing "test") to run this suite.'
      )
    }
  })

  beforeEach(async () => {
    await resetFixtures()
    await seedUsers()
  })

  after(async () => {
    await resetFixtures()
    await prisma.$disconnect()
  })

  describe('cleanupPendingLikes rollback', () => {
    it('rolls back Caw.likeCount, liker.likedCount, and author.likesReceivedCount', async () => {
      await prisma.caw.create({
        data: { id: CAW_ID, userId: AUTHOR_ID, content: 'test', action: 'CAW', cawonce: 1, likeCount: 1 },
      })
      await prisma.user.update({ where: { id: LIKER_ID }, data: { likedCount: 1 } })
      await prisma.user.update({ where: { id: AUTHOR_ID }, data: { likesReceivedCount: 1 } })
      const like = await prisma.like.create({
        data: { userId: LIKER_ID, cawId: CAW_ID, pending: true, action: 'LIKE' },
      })

      const deletedCount = await runLikeCleanup(like.id)

      const [caw, liker, author] = await Promise.all([
        prisma.caw.findUnique({ where: { id: CAW_ID } }),
        prisma.user.findUnique({ where: { id: LIKER_ID } }),
        prisma.user.findUnique({ where: { id: AUTHOR_ID } }),
      ])

      expect(deletedCount).to.equal(1)
      expect(caw!.likeCount).to.equal(0)
      expect(liker!.likedCount).to.equal(0)
      expect(author!.likesReceivedCount).to.equal(0)

      const remaining = await prisma.like.count({ where: { userId: LIKER_ID, cawId: CAW_ID } })
      expect(remaining).to.equal(0)
    })

    it('never decrements below zero (safeDecrement floor)', async () => {
      await prisma.caw.create({
        data: { id: CAW_ID, userId: AUTHOR_ID, content: 'test', action: 'CAW', cawonce: 1, likeCount: 0 },
      })
      // Counts already at 0 -- simulates a prior rollback or bookkeeping
      // drift where the optimistic bump never landed.
      const like = await prisma.like.create({
        data: { userId: LIKER_ID, cawId: CAW_ID, pending: true, action: 'LIKE' },
      })

      await runLikeCleanup(like.id)

      const [caw, liker, author] = await Promise.all([
        prisma.caw.findUnique({ where: { id: CAW_ID } }),
        prisma.user.findUnique({ where: { id: LIKER_ID } }),
        prisma.user.findUnique({ where: { id: AUTHOR_ID } }),
      ])

      expect(caw!.likeCount).to.equal(0)
      expect(liker!.likedCount).to.equal(0)
      expect(author!.likesReceivedCount).to.equal(0)
    })

    it('is a no-op when the like was already confirmed (pending: false)', async () => {
      await prisma.caw.create({
        data: { id: CAW_ID, userId: AUTHOR_ID, content: 'test', action: 'CAW', cawonce: 1, likeCount: 1 },
      })
      await prisma.user.update({ where: { id: LIKER_ID }, data: { likedCount: 1 } })
      await prisma.user.update({ where: { id: AUTHOR_ID }, data: { likesReceivedCount: 1 } })
      const like = await prisma.like.create({
        data: { userId: LIKER_ID, cawId: CAW_ID, pending: false, action: 'LIKE' },
      })

      const deletedCount = await runLikeCleanup(like.id)

      const [caw, liker, author] = await Promise.all([
        prisma.caw.findUnique({ where: { id: CAW_ID } }),
        prisma.user.findUnique({ where: { id: LIKER_ID } }),
        prisma.user.findUnique({ where: { id: AUTHOR_ID } }),
      ])

      expect(deletedCount).to.equal(0)
      expect(caw!.likeCount).to.equal(1)
      expect(liker!.likedCount).to.equal(1)
      expect(author!.likesReceivedCount).to.equal(1)

      const remaining = await prisma.like.count({ where: { userId: LIKER_ID, cawId: CAW_ID } })
      expect(remaining).to.equal(1)
    })
  })

  describe('cleanupPendingFollows rollback', () => {
    it('rolls back follower.followingCount and target.followerCount', async () => {
      await prisma.user.update({ where: { id: FOLLOWER_ID }, data: { followingCount: 1 } })
      await prisma.user.update({ where: { id: TARGET_ID }, data: { followerCount: 1 } })
      const follow = await prisma.follow.create({
        data: { followerId: FOLLOWER_ID, followingId: TARGET_ID, status: 'PENDING' },
      })

      const deletedCount = await runFollowCleanup(follow.id)

      const [follower, target] = await Promise.all([
        prisma.user.findUnique({ where: { id: FOLLOWER_ID } }),
        prisma.user.findUnique({ where: { id: TARGET_ID } }),
      ])

      expect(deletedCount).to.equal(1)
      expect(follower!.followingCount).to.equal(0)
      expect(target!.followerCount).to.equal(0)

      const remaining = await prisma.follow.count({ where: { followerId: FOLLOWER_ID, followingId: TARGET_ID } })
      expect(remaining).to.equal(0)
    })

    it('is a no-op when the follow was already confirmed (status: SUCCESS)', async () => {
      await prisma.user.update({ where: { id: FOLLOWER_ID }, data: { followingCount: 1 } })
      await prisma.user.update({ where: { id: TARGET_ID }, data: { followerCount: 1 } })
      const follow = await prisma.follow.create({
        data: { followerId: FOLLOWER_ID, followingId: TARGET_ID, status: 'SUCCESS' },
      })

      const deletedCount = await runFollowCleanup(follow.id)

      const [follower, target] = await Promise.all([
        prisma.user.findUnique({ where: { id: FOLLOWER_ID } }),
        prisma.user.findUnique({ where: { id: TARGET_ID } }),
      ])

      expect(deletedCount).to.equal(0)
      expect(follower!.followingCount).to.equal(1)
      expect(target!.followerCount).to.equal(1)
    })
  })
})

import { PrismaClient } from '@prisma/client'
import { Express } from 'express'
import http from 'http'
import path from 'path'

// Mock prisma client for tests
export const prisma = new PrismaClient()

// Clean database before each test
export async function cleanDatabase() {
  // Clean in reverse order of dependencies
  await prisma.scheduledCaw.deleteMany()
  await prisma.bookmark.deleteMany()
  await prisma.hashtag.deleteMany()
  await prisma.caw.deleteMany()
  await prisma.user.deleteMany()
}

// Create test data helpers
export async function createTestUser(data?: Partial<any>) {
  // User.id has no @default(autoincrement()) in the schema — it must be
  // supplied explicitly. Reuse the (already-random, effectively-unique
  // within a test run) tokenId rather than introducing a separate counter.
  const tokenId = data?.tokenId || Math.floor(Math.random() * 100000)
  return await prisma.user.create({
    data: {
      id: data?.id || tokenId,
      tokenId,
      username: data?.username || `testuser_${Math.random().toString(36).substring(7)}`,
      bio: data?.bio || 'Test bio',
      displayName: data?.displayName || 'Test User',
      avatarUrl: data?.avatarUrl || 'https://example.com/avatar.png',
      coverPhotoUrl: data?.coverPhotoUrl || 'https://example.com/cover.png',
      followerCount: data?.followerCount || 0,
      followingCount: data?.followingCount || 0,
      likedCount: data?.likedCount || 0,
      likesReceivedCount: data?.likesReceivedCount || 0,
      recawCount: data?.recawCount || 0,
      cawCount: data?.cawCount || 0,
      ...data
    }
  })
}

export async function createTestCaw(userId: number, data?: Partial<any>) {
  return await prisma.caw.create({
    data: {
      userId,
      content: data?.content || 'Test caw content',
      // Required, no schema default: a normal post is ActionType.CAW.
      action: data?.action || 'CAW',
      // Required, unique per (userId, cawonce) — random is fine for tests.
      cawonce: data?.cawonce ?? Math.floor(Math.random() * 1_000_000_000),
      hasImage: data?.hasImage || false,
      imageData: data?.imageData || null,
      likeCount: data?.likeCount || 0,
      recawCount: data?.recawCount || 0,
      commentCount: data?.commentCount || 0,
      viewCount: data?.viewCount || 0,
      originalCawId: data?.originalCawId || null,
      ...data
    }
  })
}

export async function createTestHashtag(name: string) {
  return await prisma.hashtag.create({
    data: {
      name,
      usageCount: 0
    }
  })
}

export async function createTestBookmark(userId: number, cawId: number) {
  return await prisma.bookmark.create({
    data: {
      userId,
      cawId
    }
  })
}

export async function createTestScheduledCaw(userId: number, data?: Partial<any>) {
  return await prisma.scheduledCaw.create({
    data: {
      userId,
      content: data?.content || 'Test scheduled content',
      scheduledAt: data?.scheduledAt || new Date(Date.now() + 24 * 60 * 60 * 1000), // Tomorrow
      status: data?.status || 'pending',
      hasImage: data?.hasImage || false,
      imageData: data?.imageData || null,
      ...data
    }
  })
}

// Create app instance for testing
export function createTestApp(): Express {
  const express = require('express')
  const cors = require('cors')
  const app = express()

  app.use(cors())
  app.use(express.json({ limit: '50mb' }))

  // Import and use routers
  const actionsRouter = require('../../src/api/routes/actions').default
  const cawRouter = require('../../src/api/routes/caws').default
  const txRouter = require('../../src/api/routes/txs').default
  const hashtagRouter = require('../../src/api/routes/hashtags').default
  const uploadRouter = require('../../src/api/routes/upload').default
  const usersRouter = require('../../src/api/routes/users').default
  const txQueueRouter = require('../../src/api/routes/txqueue').default
  const viewsRouter = require('../../src/api/routes/views').default
  const searchRouter = require('../../src/api/routes/search').default
  const bookmarksRouter = require('../../src/api/routes/bookmarks').default
  const scheduledRouter = require('../../src/api/routes/scheduled').default

  app.use('/api/actions', actionsRouter)
  app.use('/api/caws', cawRouter)
  app.use('/api/txs', txRouter)
  app.use('/api/hashtags', hashtagRouter)
  app.use('/api/upload', uploadRouter)
  app.use('/api/users', usersRouter)
  app.use('/api/txqueue', txQueueRouter)
  app.use('/api/views', viewsRouter)
  app.use('/api/search', searchRouter)
  app.use('/api/bookmarks', bookmarksRouter)
  app.use('/api/scheduled', scheduledRouter)

  return app
}
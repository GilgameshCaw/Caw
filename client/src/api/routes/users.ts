// src/api/routes/users.ts
import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { ActionType } from '@prisma/client'

const router = Router()

/**
 * GET /api/users/follow-status?followerId=X&followingId=Y
 * Check the current follow status between two users
 * IMPORTANT: This route must be defined BEFORE /:username to avoid conflicts
 */
router.get('/follow-status', async (req, res) => {
  try {
    const followerId = Number(req.query.followerId)
    const followingId = Number(req.query.followingId)

    if (!followerId || !followingId) {
      return res.status(400).json({ error: 'followerId and followingId are required' })
    }

    const follow = await prisma.follow.findUnique({
      where: {
        followerId_followingId: {
          followerId,
          followingId
        }
      },
      select: {
        action: true,
        status: true
      }
    })

    if (!follow) {
      return res.json({
        isFollowing: false,
        isPending: false
      })
    }

    return res.json({
      isFollowing: follow.action === 'FOLLOW' && follow.status === 'SUCCESS',
      isPending: follow.status === 'PENDING'
    })
  } catch (err: any) {
    console.error('GET /api/users/follow-status error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/users/:username
 * Returns user profile data with accurate counts
 */
router.get('/:username', async (req, res) => {
  try {
    const { username } = req.params
    const currentUserId = Number(req.header('x-user-id')) || undefined

    // Fetch user with counts
    const user = await prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        address: true,
        tokenId: true,
        username: true,
        image: true,
        createdAt: true,
        updatedAt: true,
        // Profile fields
        bio: true,
        displayName: true,
        location: true,
        website: true,
        avatarUrl: true,
        coverPhotoUrl: true,
        profileUpdatePending: true,
        lastStakedAt: true,
        // Include counts
        _count: {
          select: {
            caws: true,
            followers: true,
            follows: true,
          }
        }
      }
    })

    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Get actual like count (total likes received on all caws)
    const likeCount = await prisma.like.count({
      where: {
        caw: {
          userId: user.tokenId
        },
        action: ActionType.LIKE
      }
    })

    // Check if current user is following this user
    let isFollowing = false
    let followPending = false
    if (currentUserId && currentUserId !== user.tokenId) {
      const follow = await prisma.follow.findUnique({
        where: {
          followerId_followingId: {
            followerId: currentUserId,
            followingId: user.tokenId
          }
        },
        select: {
          action: true,
          status: true
        }
      })

      if (follow) {
        // Only set isFollowing if action is FOLLOW and status is SUCCESS
        isFollowing = follow.action === 'FOLLOW' && follow.status === 'SUCCESS'
        // Set pending if status is PENDING
        followPending = follow.status === 'PENDING'
      }
    }

    // Format response
    const response = {
      ...user,
      cawCount: user._count.caws,
      followerCount: user._count.followers,
      followingCount: user._count.follows,
      likeCount,
      isFollowing,
      followPending,
      // Remove the _count field
      _count: undefined
    }

    return res.json(response)
  } catch (err: any) {
    console.error('GET /api/users/:username error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/users/:username/followers
 * Returns list of users who follow this user
 */
router.get('/:username/followers', async (req, res) => {
  try {
    const { username } = req.params
    const currentUserId = Number(req.header('x-user-id')) || undefined
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100)
    const cursor = req.query.cursor ? Number(req.query.cursor) : undefined

    // Get the user
    const user = await prisma.user.findUnique({
      where: { username },
      select: { tokenId: true }
    })

    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Get followers
    const followers = await prisma.follow.findMany({
      where: {
        followingId: user.tokenId,
        action: ActionType.FOLLOW
      },
      take: limit + 1,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        follower: {
          select: {
            id: true,
            tokenId: true,
            username: true,
            image: true,
            displayName: true,
            bio: true,
            avatarUrl: true
          }
        }
      }
    })

    const hasMore = followers.length > limit
    const followersList = followers.slice(0, limit)
    const nextCursor = hasMore ? followers[limit - 1].id : undefined

    // For each follower, check if current user is following them
    const items = await Promise.all(followersList.map(async (f) => {
      let isFollowing = false
      let followPending = false

      if (currentUserId && currentUserId !== f.follower.tokenId) {
        const follow = await prisma.follow.findUnique({
          where: {
            followerId_followingId: {
              followerId: currentUserId,
              followingId: f.follower.tokenId
            }
          },
          select: {
            action: true,
            status: true
          }
        })

        if (follow) {
          isFollowing = follow.action === 'FOLLOW' && follow.status === 'SUCCESS'
          followPending = follow.status === 'PENDING'
        }
      }

      return {
        ...f.follower,
        isFollowing,
        followPending
      }
    }))

    return res.json({ items, nextCursor })
  } catch (err: any) {
    console.error('GET /api/users/:username/followers error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/users/:username/following
 * Returns list of users this user follows
 */
router.get('/:username/following', async (req, res) => {
  try {
    const { username } = req.params
    const currentUserId = Number(req.header('x-user-id')) || undefined
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100)
    const cursor = req.query.cursor ? Number(req.query.cursor) : undefined

    // Get the user
    const user = await prisma.user.findUnique({
      where: { username },
      select: { tokenId: true }
    })

    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Get following
    const following = await prisma.follow.findMany({
      where: {
        followerId: user.tokenId,
        action: ActionType.FOLLOW
      },
      take: limit + 1,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        following: {
          select: {
            id: true,
            tokenId: true,
            username: true,
            image: true,
            displayName: true,
            bio: true,
            avatarUrl: true
          }
        }
      }
    })

    const hasMore = following.length > limit
    const followingList = following.slice(0, limit)
    const nextCursor = hasMore ? following[limit - 1].id : undefined

    // For each following user, check if current user is following them
    const items = await Promise.all(followingList.map(async (f) => {
      let isFollowing = false
      let followPending = false

      if (currentUserId && currentUserId !== f.following.tokenId) {
        const follow = await prisma.follow.findUnique({
          where: {
            followerId_followingId: {
              followerId: currentUserId,
              followingId: f.following.tokenId
            }
          },
          select: {
            action: true,
            status: true
          }
        })

        if (follow) {
          isFollowing = follow.action === 'FOLLOW' && follow.status === 'SUCCESS'
          followPending = follow.status === 'PENDING'
        }
      }

      return {
        ...f.following,
        isFollowing,
        followPending
      }
    }))

    return res.json({ items, nextCursor })
  } catch (err: any) {
    console.error('GET /api/users/:username/following error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/users/search/:query
 * Search for users by username prefix (for @mention autocomplete)
 */
router.get('/search/:query', async (req, res) => {
  try {
    const { query } = req.params
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 20)

    if (!query || query.length < 1) {
      return res.json({ users: [] })
    }

    // Search for users whose username starts with the query (case insensitive)
    const users = await prisma.user.findMany({
      where: {
        username: {
          startsWith: query.toLowerCase(),
          mode: 'insensitive'
        }
      },
      select: {
        tokenId: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        image: true,
      },
      take: limit,
      orderBy: {
        username: 'asc'
      }
    })

    return res.json({ users })
  } catch (err: any) {
    console.error('GET /api/users/search/:query error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * PATCH /api/users/:username
 * Update user fields (currently just lastStakedAt for LayerZero tracking)
 */
router.patch('/:username', async (req, res) => {
  try {
    const { username } = req.params
    const { lastStakedAt } = req.body

    // Only allow updating lastStakedAt for now
    if (!lastStakedAt) {
      return res.status(400).json({ error: 'lastStakedAt is required' })
    }

    await prisma.user.update({
      where: { username },
      data: {
        lastStakedAt: new Date(lastStakedAt)
      }
    })

    return res.json({ success: true })
  } catch (err: any) {
    console.error('PATCH /api/users/:username error', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
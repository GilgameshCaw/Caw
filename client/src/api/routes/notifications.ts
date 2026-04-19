import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { NotificationService } from '../../services/NotificationService'
import { NotificationType } from '@prisma/client'
import { requireAuth } from '../middleware/auth'
import { getBlockedUserIds } from '../shared/blockUtils'

const router = Router()

/**
 * GET /api/notifications
 * Get notifications for the authenticated user
 */
router.get('/', requireAuth({ lookup: async (req) => Number(req.query.userId) || undefined }), async (req, res) => {
  try {
    const { userId, type, limit = 50, offset = 0, unreadOnly = false } = req.query

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' })
    }

    const userTokenId = parseInt(userId as string)
    const notificationLimit = Math.min(Number(limit), 100)
    const notificationOffset = Number(offset)

    // Filter out notifications from blocked users
    const blockedIds = await getBlockedUserIds(userTokenId)

    // Build where clause
    const where: any = { userId: userTokenId, hidden: false }

    if (blockedIds.length > 0) {
      where.actorId = { notIn: blockedIds }
    }

    if (type && type !== 'all') {
      if (type === 'mentions') {
        where.type = NotificationType.MENTION
      } else if (Object.values(NotificationType).includes(type as NotificationType)) {
        where.type = type as NotificationType
      }
    }

    if (unreadOnly === 'true') {
      where.isRead = false
    }

    // Get notifications with grouping for likes and reposts
    const notifications = await prisma.notification.findMany({
      where,
      take: notificationLimit,
      skip: notificationOffset,
      orderBy: { createdAt: 'desc' },
      include: {
        actor: {
          select: {
            tokenId: true,
            username: true,
            displayName: true,
            avatarUrl: true, defaultAvatarId: true
          }
        },
        caw: {
          select: {
            id: true,
            content: true,
            createdAt: true
          }
        },
        offer: {
          select: {
            id: true,
            offerId: true,
            tokenId: true,
            offerer: true,
            amount: true,
            paymentToken: true,
            username: true,
            expiry: true,
            status: true
          }
        }
      }
    })

    // For ACTION_FAILED notifications, batch-fetch context the client needs
    // to render a human-readable description:
    //   - receiver usernames → "Following @alice failed"
    //   - target caws (for like / recaw / reply) → a snippet + author
    // Two queries total for the whole page regardless of how many failures.
    const receiverIds = new Set<number>()
    const targetCawKeys = new Set<string>()  // key = `${userId}:${cawonce}`
    for (const n of notifications) {
      if ((n as any).type === 'ACTION_FAILED') {
        const p = (n as any).actionPayload
        if (p?.receiverId != null) receiverIds.add(p.receiverId)
        if (p?.receiverId != null && p?.receiverCawonce != null) {
          targetCawKeys.add(`${p.receiverId}:${p.receiverCawonce}`)
        }
      }
    }
    const receiverUsernames = new Map<number, string>()
    if (receiverIds.size > 0) {
      const users = await prisma.user.findMany({
        where: { tokenId: { in: Array.from(receiverIds) } },
        select: { tokenId: true, username: true }
      })
      for (const u of users) receiverUsernames.set(u.tokenId, u.username)
    }
    const targetCaws = new Map<string, { content: string; username: string }>()
    if (targetCawKeys.size > 0) {
      // Build an OR query across (userId, cawonce) pairs. Prisma doesn't
      // support compound IN, so we use an OR list — typically 1-10 items.
      const orConditions = Array.from(targetCawKeys).map(key => {
        const [userIdStr, cawonceStr] = key.split(':')
        return { userId: Number(userIdStr), cawonce: Number(cawonceStr) }
      })
      const caws = await prisma.caw.findMany({
        where: { OR: orConditions },
        select: { userId: true, cawonce: true, content: true, user: { select: { username: true } } }
      })
      for (const c of caws) {
        targetCaws.set(`${c.userId}:${c.cawonce}`, {
          content: c.content,
          username: c.user.username,
        })
      }
    }

    // Group similar notifications (likes and reposts on same caw)
    const groupedNotifications: any[] = []
    const groupMap = new Map<string, any>()

    for (const notification of notifications) {
      // Group LIKE, REPOST, and TIP notifications
      if ((notification.type === 'LIKE' || notification.type === 'REPOST' || notification.type === 'TIP') && notification.groupKey) {
        const existing = groupMap.get(notification.groupKey)
        if (existing) {
          // Add to existing group
          existing.additionalActors.push({
            tokenId: notification.actor.tokenId,
            username: notification.actor.username,
            displayName: notification.actor.displayName,
            avatarUrl: notification.actor.avatarUrl
          })
          existing.count++
          // Update read status - group is unread if any notification is unread
          if (!notification.isRead) {
            existing.isRead = false
          }
          // Keep track of all notification IDs in this group
          existing.notificationIds.push(notification.id)
        } else {
          // Create new group
          groupMap.set(notification.groupKey, {
            id: notification.id,
            type: notification.type,
            actor: notification.actor,
            additionalActors: [],
            caw: notification.caw,
            isRead: notification.isRead,
            createdAt: notification.createdAt,
            count: 1,
            notificationIds: [notification.id],
            groupKey: notification.groupKey
          })
        }
      } else {
        // Don't group - add as individual notification.
        // For ACTION_FAILED notifications, enrich the payload with the target
        // user's username and (for like / recaw / quote / reply) the target
        // caw's content + author. Lets the frontend render "Following @alice
        // failed" or "Like on @bob's caw 'text...' failed" without a lookup.
        let actionPayload: any = (notification as any).actionPayload ?? null
        if ((notification as any).type === 'ACTION_FAILED' && actionPayload) {
          const enriched = { ...actionPayload }
          if (actionPayload.receiverId != null) {
            const uname = receiverUsernames.get(actionPayload.receiverId)
            if (uname) enriched.receiverUsername = uname
          }
          if (actionPayload.receiverId != null && actionPayload.receiverCawonce != null) {
            const target = targetCaws.get(`${actionPayload.receiverId}:${actionPayload.receiverCawonce}`)
            if (target) {
              enriched.targetCaw = {
                content: target.content.slice(0, 140),
                authorUsername: target.username,
              }
            }
          }
          actionPayload = enriched
        }
        groupedNotifications.push({
          id: notification.id,
          type: notification.type,
          actor: notification.actor,
          caw: notification.caw,
          offer: (notification as any).offer || null,
          actionPayload,
          isRead: notification.isRead,
          createdAt: notification.createdAt,
          notificationIds: [notification.id]
        })
      }
    }

    // Add grouped notifications to result
    groupedNotifications.push(...Array.from(groupMap.values()))

    // Sort by createdAt
    groupedNotifications.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )

    // Get unread count (also filtered by blocked users)
    const unreadWhere: any = { userId: userTokenId, isRead: false, hidden: false }
    if (blockedIds.length > 0) {
      unreadWhere.actorId = { notIn: blockedIds }
    }
    const unreadCount = await prisma.notification.count({ where: unreadWhere })

    return res.json({
      notifications: groupedNotifications,
      unreadCount,
      hasMore: notifications.length === notificationLimit
    })

  } catch (error) {
    console.error('GET /api/notifications error:', error)
    return res.status(500).json({ error: 'Failed to get notifications' })
  }
})

/**
 * GET /api/notifications/unread-count
 * Get unread notification count for a user
 */
router.get('/unread-count', requireAuth({ lookup: async (req) => Number(req.query.userId) || undefined }), async (req, res) => {
  try {
    const { userId } = req.query

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' })
    }

    const userTokenId = parseInt(userId as string)

    // Filter out notifications from blocked users
    const blockedIds = await getBlockedUserIds(userTokenId)
    const unreadWhere: any = { userId: userTokenId, isRead: false, hidden: false }
    if (blockedIds.length > 0) {
      unreadWhere.actorId = { notIn: blockedIds }
    }
    const unreadCount = await prisma.notification.count({ where: unreadWhere })

    return res.json({ unreadCount })

  } catch (error) {
    console.error('GET /api/notifications/unread-count error:', error)
    return res.status(500).json({ error: 'Failed to get unread count' })
  }
})

/**
 * POST /api/notifications/read
 * Mark notifications as read
 */
router.post('/read', requireAuth({ field: 'userId' }), async (req, res) => {
  try {
    const { userId, notificationIds } = req.body

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' })
    }

    const userTokenId = parseInt(userId)

    // If notificationIds provided, mark specific ones as read
    // Otherwise mark all as read for the user
    await NotificationService.markAsRead(userTokenId, notificationIds)

    return res.json({ success: true })

  } catch (error) {
    console.error('POST /api/notifications/read error:', error)
    return res.status(500).json({ error: 'Failed to mark notifications as read' })
  }
})

/**
 * PATCH /api/notifications/:id/hide
 * Hide a notification (soft delete)
 */
router.patch('/:id/hide', requireAuth({ field: 'userId' }), async (req, res) => {
  try {
    const { id } = req.params
    const { userId } = req.body

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' })
    }

    const notificationId = parseInt(id)
    const userTokenId = parseInt(userId)

    // Verify the notification belongs to the user
    const notification = await prisma.notification.findFirst({
      where: {
        id: notificationId,
        userId: userTokenId
      }
    })

    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' })
    }

    // Hide the notification
    await prisma.notification.update({
      where: { id: notificationId },
      data: { hidden: true }
    })

    return res.json({ success: true })

  } catch (error) {
    console.error('PATCH /api/notifications/:id/hide error:', error)
    return res.status(500).json({ error: 'Failed to hide notification' })
  }
})

/**
 * POST /api/notifications/hide-by-original-tx
 *
 * Hide any ACTION_FAILED notifications whose actionPayload.originalTxQueueId
 * matches the provided txQueueId, scoped to the authenticated user.
 *
 * Called by the frontend's useTxQueueMonitor auto-retry path after a
 * successful cawonce-collision retry: the original notification becomes
 * obsolete because the action effectively succeeded, and we don't want the
 * user to see a "failed" notification for something that worked.
 *
 * Safe even if no matching notification exists — returns count: 0.
 */
router.post('/hide-by-original-tx', requireAuth({ field: 'userId' }), async (req, res) => {
  try {
    const { userId, txQueueId } = req.body

    if (!userId || txQueueId == null) {
      return res.status(400).json({ error: 'userId and txQueueId are required' })
    }

    const userTokenId = Number(userId)
    const targetTxQueueId = Number(txQueueId)
    if (!Number.isFinite(userTokenId) || !Number.isFinite(targetTxQueueId)) {
      return res.status(400).json({ error: 'Invalid userId or txQueueId' })
    }

    // Prisma's JSON filtering varies by provider — for Postgres we can use
    // `path` filtering. Find matches first so we can return a count, then
    // update them in bulk.
    const matches = await prisma.notification.findMany({
      where: {
        userId: userTokenId,
        type: 'ACTION_FAILED',
        hidden: false,
        actionPayload: {
          path: ['originalTxQueueId'],
          equals: targetTxQueueId,
        } as any,
      },
      select: { id: true },
    })

    if (matches.length === 0) {
      return res.json({ success: true, count: 0 })
    }

    await prisma.notification.updateMany({
      where: { id: { in: matches.map(m => m.id) } },
      data: { hidden: true },
    })

    return res.json({ success: true, count: matches.length, ids: matches.map(m => m.id) })

  } catch (error: any) {
    console.error('POST /api/notifications/hide-by-original-tx error:', error)
    return res.status(500).json({ error: 'Failed to hide notifications' })
  }
})

/**
 * POST /api/notifications/test
 * Create test notifications (for development)
 */
router.post('/test', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Test endpoint not available in production' })
  }

  try {
    const { userId, actorId, type, cawId } = req.body

    if (!userId || !actorId || !type) {
      return res.status(400).json({ error: 'userId, actorId, and type are required' })
    }

    const notification = await prisma.notification.create({
      data: {
        userId: parseInt(userId),
        actorId: parseInt(actorId),
        type: type as NotificationType,
        cawId: cawId ? parseInt(cawId) : undefined
      }
    })

    return res.json({ notification })

  } catch (error) {
    console.error('POST /api/notifications/test error:', error)
    return res.status(500).json({ error: 'Failed to create test notification' })
  }
})

// Note: Muting accounts/threads is handled client-side (localStorage) for privacy reasons.
// No server-side mute routes needed.

/**
 * GET /api/notifications/is-account-muted/:tokenId
 * Check if a specific account is muted by the user
 */
router.get('/is-account-muted/:tokenId', async (req, res) => {
  try {
    const userId = Number(req.header('x-user-id'))
    const targetUserId = parseInt(req.params.tokenId)

    if (!userId) {
      return res.status(400).json({ error: 'x-user-id header is required' })
    }

    if (!targetUserId || isNaN(targetUserId)) {
      return res.status(400).json({ error: 'Valid tokenId is required' })
    }

    const isMuted = await NotificationService.isAccountMuted(userId, targetUserId)

    return res.json({ isMuted })

  } catch (error) {
    console.error('GET /api/notifications/is-account-muted error:', error)
    return res.status(500).json({ error: 'Failed to check mute status' })
  }
})

// Note: Blocked accounts are handled client-side (localStorage) for privacy reasons.
// No server-side blocked account routes needed.

export default router
import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { NotificationService } from '../../services/NotificationService'
import { NotificationType } from '@prisma/client'

const router = Router()

/**
 * GET /api/notifications
 * Get notifications for the authenticated user
 */
router.get('/', async (req, res) => {
  try {
    const { userId, type, limit = 50, offset = 0, unreadOnly = false } = req.query

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' })
    }

    const userTokenId = parseInt(userId as string)
    const notificationLimit = Math.min(Number(limit), 100)
    const notificationOffset = Number(offset)

    // Build where clause
    const where: any = { userId: userTokenId }

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
            avatarUrl: true
          }
        },
        caw: {
          select: {
            id: true,
            content: true,
            createdAt: true
          }
        }
      }
    })

    // Group similar notifications (likes and reposts on same caw)
    const groupedNotifications: any[] = []
    const groupMap = new Map<string, any>()

    for (const notification of notifications) {
      // Only group LIKE and REPOST notifications
      if ((notification.type === 'LIKE' || notification.type === 'REPOST') && notification.groupKey) {
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
        // Don't group - add as individual notification
        groupedNotifications.push({
          id: notification.id,
          type: notification.type,
          actor: notification.actor,
          caw: notification.caw,
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

    // Get unread count
    const unreadCount = await NotificationService.getUnreadCount(userTokenId)

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
router.get('/unread-count', async (req, res) => {
  try {
    const { userId } = req.query

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' })
    }

    const userTokenId = parseInt(userId as string)
    const unreadCount = await NotificationService.getUnreadCount(userTokenId)

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
router.post('/read', async (req, res) => {
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
 * DELETE /api/notifications/:id
 * Delete a notification
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { userId } = req.query

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' })
    }

    const notificationId = parseInt(id)
    const userTokenId = parseInt(userId as string)

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

    // Delete the notification
    await prisma.notification.delete({
      where: { id: notificationId }
    })

    return res.json({ success: true })

  } catch (error) {
    console.error('DELETE /api/notifications/:id error:', error)
    return res.status(500).json({ error: 'Failed to delete notification' })
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

export default router
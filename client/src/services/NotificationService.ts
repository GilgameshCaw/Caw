import { prisma } from '../prismaClient'
import { NotificationType } from '@prisma/client'

export class NotificationService {
  /**
   * Extract @mentions from a caw content
   */
  static extractMentions(content: string): string[] {
    const mentionRegex = /@(\w+)/g
    const mentions: string[] = []
    let match

    while ((match = mentionRegex.exec(content)) !== null) {
      mentions.push(match[1])
    }

    return [...new Set(mentions)] // Remove duplicates
  }

  /**
   * Create notifications for @mentions in a caw
   */
  static async createMentionNotifications(cawId: number, content: string, actorId: number) {
    const mentions = this.extractMentions(content)

    if (mentions.length === 0) return

    // Find users with mentioned usernames
    const mentionedUsers = await prisma.user.findMany({
      where: {
        username: { in: mentions },
        tokenId: { not: actorId } // Don't notify the actor of their own mention
      }
    })

    // Create notifications for each mentioned user
    const notifications = mentionedUsers.map(user => ({
      userId: user.tokenId,
      actorId,
      type: NotificationType.MENTION,
      cawId
    }))

    if (notifications.length > 0) {
      await prisma.notification.createMany({
        data: notifications,
        skipDuplicates: true
      })
    }
  }

  /**
   * Create notification for a follow action
   */
  static async createFollowNotification(followedId: number, followerId: number) {
    // Don't notify if user follows themselves
    if (followedId === followerId) return

    await prisma.notification.create({
      data: {
        userId: followedId,
        actorId: followerId,
        type: NotificationType.FOLLOW
      }
    })
  }

  /**
   * Create notification for a like action
   */
  static async createLikeNotification(cawId: number, likerId: number) {
    // Get the caw to find its owner
    const caw = await prisma.caw.findUnique({
      where: { id: cawId },
      select: { userId: true }
    })

    if (!caw || caw.userId === likerId) return // Don't notify for self-likes

    // Check if notification already exists to avoid duplicates
    const existing = await prisma.notification.findFirst({
      where: {
        userId: caw.userId,
        actorId: likerId,
        type: NotificationType.LIKE,
        cawId
      }
    })

    if (!existing) {
      await prisma.notification.create({
        data: {
          userId: caw.userId,
          actorId: likerId,
          type: NotificationType.LIKE,
          cawId,
          groupKey: `like_caw_${cawId}`
        }
      })
    }
  }

  /**
   * Create notification for a reply
   */
  static async createReplyNotification(parentCawId: number, replyCawId: number, replierId: number) {
    // Get the parent caw to find its owner
    const parentCaw = await prisma.caw.findUnique({
      where: { id: parentCawId },
      select: { userId: true }
    })

    if (!parentCaw || parentCaw.userId === replierId) return // Don't notify for self-replies

    await prisma.notification.create({
      data: {
        userId: parentCaw.userId,
        actorId: replierId,
        type: NotificationType.REPLY,
        cawId: replyCawId
      }
    })
  }

  /**
   * Create notification for a repost
   */
  static async createRepostNotification(originalCawId: number, reposterId: number) {
    // Get the original caw to find its owner
    const originalCaw = await prisma.caw.findUnique({
      where: { id: originalCawId },
      select: { userId: true }
    })

    if (!originalCaw || originalCaw.userId === reposterId) return // Don't notify for self-reposts

    await prisma.notification.create({
      data: {
        userId: originalCaw.userId,
        actorId: reposterId,
        type: NotificationType.REPOST,
        cawId: originalCawId,
        groupKey: `repost_caw_${originalCawId}`
      }
    })
  }

  /**
   * Create notification for a quote
   */
  static async createQuoteNotification(originalCawId: number, quoteCawId: number, quoterId: number) {
    // Get the original caw to find its owner
    const originalCaw = await prisma.caw.findUnique({
      where: { id: originalCawId },
      select: { userId: true }
    })

    if (!originalCaw || originalCaw.userId === quoterId) return // Don't notify for self-quotes

    await prisma.notification.create({
      data: {
        userId: originalCaw.userId,
        actorId: quoterId,
        type: NotificationType.QUOTE,
        cawId: quoteCawId
      }
    })
  }

  /**
   * Mark notifications as read
   */
  static async markAsRead(userId: number, notificationIds?: number[]) {
    if (notificationIds) {
      // Mark specific notifications as read
      await prisma.notification.updateMany({
        where: {
          id: { in: notificationIds },
          userId
        },
        data: { isRead: true }
      })
    } else {
      // Mark all notifications as read for the user
      await prisma.notification.updateMany({
        where: { userId, isRead: false },
        data: { isRead: true }
      })
    }
  }

  /**
   * Get unread notification count
   */
  static async getUnreadCount(userId: number): Promise<number> {
    return await prisma.notification.count({
      where: {
        userId,
        isRead: false
      }
    })
  }
}
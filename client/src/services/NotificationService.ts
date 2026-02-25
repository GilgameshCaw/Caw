import { prisma } from '../prismaClient'
import { NotificationType } from '@prisma/client'
import { elasticsearchService } from './ElasticsearchService'

export class NotificationService {
  /**
   * Get the root thread ID for a caw (follows parent chain to find root)
   */
  static async getThreadRootId(cawId: number): Promise<number> {
    let currentId = cawId
    let maxDepth = 100 // Prevent infinite loops

    while (maxDepth > 0) {
      const caw = await prisma.caw.findUnique({
        where: { id: currentId },
        select: { id: true, originalCawId: true }
      })

      if (!caw || !caw.originalCawId) {
        return currentId // This is the root
      }

      currentId = caw.originalCawId
      maxDepth--
    }

    return currentId
  }

  /**
   * Check if a user has muted a thread containing this caw
   */
  static async isThreadMutedForUser(userId: number, cawId: number): Promise<boolean> {
    const threadRootId = await this.getThreadRootId(cawId)

    // Check if user has muted any caw in this thread's ancestry
    // We check the root and the caw itself
    const mutedThread = await prisma.mutedThread.findFirst({
      where: {
        userId,
        cawId: { in: [threadRootId, cawId] }
      }
    })

    return !!mutedThread
  }

  /**
   * Check if a user has muted or blocked another user
   * Returns true if the actor should not be able to send notifications to the user
   */
  static async isUserMutedOrBlocked(userId: number, actorId: number): Promise<boolean> {
    // Check if actor is muted
    const muted = await prisma.mutedAccount.findUnique({
      where: {
        userId_mutedUserId: { userId, mutedUserId: actorId }
      }
    })
    if (muted) return true

    // Blocking is handled client-side (localStorage), not server-side
    return false
  }

  // --- Muted Account Management ---

  /**
   * Mute an account for a user
   */
  static async muteAccount(userId: number, mutedUserId: number): Promise<void> {
    await prisma.mutedAccount.upsert({
      where: {
        userId_mutedUserId: { userId, mutedUserId }
      },
      create: { userId, mutedUserId },
      update: {}
    })
  }

  /**
   * Unmute an account for a user
   */
  static async unmuteAccount(userId: number, mutedUserId: number): Promise<void> {
    await prisma.mutedAccount.deleteMany({
      where: { userId, mutedUserId }
    })
  }

  /**
   * Get all muted accounts for a user
   */
  static async getMutedAccounts(userId: number): Promise<number[]> {
    const muted = await prisma.mutedAccount.findMany({
      where: { userId },
      select: { mutedUserId: true }
    })
    return muted.map(m => m.mutedUserId)
  }

  /**
   * Check if an account is muted
   */
  static async isAccountMuted(userId: number, mutedUserId: number): Promise<boolean> {
    const muted = await prisma.mutedAccount.findUnique({
      where: {
        userId_mutedUserId: { userId, mutedUserId }
      }
    })
    return !!muted
  }

  // Note: Blocking is handled client-side (localStorage) for privacy reasons.
  // No server-side blocked account management needed.

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

    // Filter out users who have muted or blocked the actor
    const filteredUsers = []
    for (const user of mentionedUsers) {
      const isMutedOrBlocked = await this.isUserMutedOrBlocked(user.tokenId, actorId)
      if (!isMutedOrBlocked) {
        filteredUsers.push(user)
      }
    }

    // Create notifications for each mentioned user
    const notifications = filteredUsers.map(user => ({
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

    // Check if the recipient has muted or blocked the actor
    if (await this.isUserMutedOrBlocked(followedId, followerId)) {
      return // User is muted/blocked, don't send notification
    }

    // Check if notification already exists to avoid duplicates
    const existing = await prisma.notification.findFirst({
      where: {
        userId: followedId,
        actorId: followerId,
        type: NotificationType.FOLLOW
      }
    })

    if (!existing) {
      await prisma.notification.create({
        data: {
          userId: followedId,
          actorId: followerId,
          type: NotificationType.FOLLOW
        }
      })
    }
  }

  /**
   * Create notification for a like action
   */
  static async createLikeNotification(cawId: number, likerId: number) {
    console.log(`[createLikeNotification] Starting: cawId=${cawId}, likerId=${likerId}`)

    // Get the caw to find its owner
    const caw = await prisma.caw.findUnique({
      where: { id: cawId },
      select: { userId: true }
    })

    console.log(`[createLikeNotification] Found caw:`, caw)

    if (!caw) {
      console.log(`[createLikeNotification] Caw not found, skipping`)
      return
    }

    if (caw.userId === likerId) {
      console.log(`[createLikeNotification] Self-like detected (caw.userId=${caw.userId} === likerId=${likerId}), skipping`)
      return
    }

    // Check if the recipient has muted or blocked the actor
    if (await this.isUserMutedOrBlocked(caw.userId, likerId)) {
      console.log(`[createLikeNotification] User ${likerId} is muted/blocked by ${caw.userId}, skipping`)
      return
    }

    // Check if the recipient has muted this thread
    if (await this.isThreadMutedForUser(caw.userId, cawId)) {
      console.log(`[createLikeNotification] Thread ${cawId} is muted by user ${caw.userId}, skipping`)
      return
    }

    // Check if notification already exists to avoid duplicates
    const existing = await prisma.notification.findFirst({
      where: {
        userId: caw.userId,
        actorId: likerId,
        type: NotificationType.LIKE,
        cawId
      }
    })

    console.log(`[createLikeNotification] Existing notification:`, existing)

    if (!existing) {
      console.log(`[createLikeNotification] Creating new notification for userId=${caw.userId}`)
      const notification = await prisma.notification.create({
        data: {
          userId: caw.userId,
          actorId: likerId,
          type: NotificationType.LIKE,
          cawId,
          groupKey: `like_caw_${cawId}`
        }
      })
      console.log(`[createLikeNotification] Created notification:`, notification)
    } else {
      console.log(`[createLikeNotification] Notification already exists, skipping`)
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

    // Check if the recipient has muted or blocked the actor
    if (await this.isUserMutedOrBlocked(parentCaw.userId, replierId)) {
      return // User is muted/blocked, don't send notification
    }

    // Check if the recipient has muted this thread
    if (await this.isThreadMutedForUser(parentCaw.userId, parentCawId)) {
      return // Thread is muted, don't send notification
    }

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

    // Check if the recipient has muted or blocked the actor
    if (await this.isUserMutedOrBlocked(originalCaw.userId, reposterId)) {
      return // User is muted/blocked, don't send notification
    }

    // Check if the recipient has muted this thread
    if (await this.isThreadMutedForUser(originalCaw.userId, originalCawId)) {
      return // Thread is muted, don't send notification
    }

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

    // Check if the recipient has muted or blocked the actor
    if (await this.isUserMutedOrBlocked(originalCaw.userId, quoterId)) {
      return // User is muted/blocked, don't send notification
    }

    // Check if the recipient has muted this thread
    if (await this.isThreadMutedForUser(originalCaw.userId, originalCawId)) {
      return // Thread is muted, don't send notification
    }

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

  /**
   * Mute a thread for a user (no notifications from this thread)
   */
  static async muteThread(userId: number, cawId: number): Promise<void> {
    await prisma.mutedThread.upsert({
      where: {
        userId_cawId: { userId, cawId }
      },
      create: { userId, cawId },
      update: {} // No update needed, just ensure it exists
    })
  }

  /**
   * Unmute a thread for a user
   */
  static async unmuteThread(userId: number, cawId: number): Promise<void> {
    await prisma.mutedThread.deleteMany({
      where: { userId, cawId }
    })
  }

  /**
   * Get all muted threads for a user
   */
  static async getMutedThreads(userId: number): Promise<number[]> {
    const mutedThreads = await prisma.mutedThread.findMany({
      where: { userId },
      select: { cawId: true }
    })
    return mutedThreads.map(t => t.cawId)
  }

  /**
   * Check if a specific thread is muted by a user
   */
  static async isThreadMuted(userId: number, cawId: number): Promise<boolean> {
    const muted = await prisma.mutedThread.findUnique({
      where: {
        userId_cawId: { userId, cawId }
      }
    })
    return !!muted
  }
}
import { prisma } from '../prismaClient'
import { NotificationType } from '@prisma/client'
import { elasticsearchService } from './ElasticsearchService'

export class NotificationService {
  /**
   * Get the root thread ID for a caw (follows parent chain to find root).
   *
   * Previously this walked the parent chain one prisma.findUnique call at
   * a time, with a 100-depth fuse. For a deep thread that's 100 sequential
   * DB round-trips. Now: a single recursive CTE that resolves the root in
   * one query. The 100-depth fuse becomes a SQL LIMIT on the CTE so we
   * still terminate on accidental cycles. Audit fix 2026-05-13.
   *
   * If the CTE finds nothing (the cawId doesn't exist) we return the
   * original id — preserves the old behaviour where a missing caw was
   * treated as "this IS the root."
   */
  static async getThreadRootId(cawId: number): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ id: number }>>`
      WITH RECURSIVE chain (id, "originalCawId", depth) AS (
        SELECT id, "originalCawId", 0
        FROM "Caw"
        WHERE id = ${cawId}
        UNION ALL
        SELECT c.id, c."originalCawId", chain.depth + 1
        FROM "Caw" c
        INNER JOIN chain ON c.id = chain."originalCawId"
        WHERE chain.depth < 100
      )
      SELECT id FROM chain WHERE "originalCawId" IS NULL OR depth = 100
      ORDER BY depth DESC
      LIMIT 1
    `
    return rows[0]?.id ?? cawId
  }

  // Note: Muting accounts/threads is handled client-side (localStorage) for privacy reasons.
  // These stub functions always return false since the server doesn't track mutes/blocks.

  /**
   * Check if a user has muted or blocked another user (stub - always returns false)
   */
  static async isUserMutedOrBlocked(_userId: number, _actorId: number): Promise<boolean> {
    return false
  }

  /**
   * Check if a thread is muted for a user (stub - always returns false)
   */
  static async isThreadMutedForUser(_userId: number, _threadId: number): Promise<boolean> {
    return false
  }

  /**
   * Check if a specific account is muted by the user (stub - always returns false)
   * Muting is handled client-side via localStorage for privacy reasons.
   */
  static async isAccountMuted(_userId: number, _targetUserId: number): Promise<boolean> {
    return false
  }

  /**
   * Maximum distinct @mentions we'll notify on per caw.
   *
   * On-chain `text` caps at 420 bytes; an attacker can fit ~210 distinct
   * 1-char mentions (`@a @b ...`) and force 210 notification rows + 210
   * push events from one signed action. The realistic conversation
   * pattern is well under 10 mentions; cap there to bound write
   * amplification under attack. Audit fix 2026-05-09 (Round 6 economic
   * agent HIGH-3).
   */
  static readonly MAX_MENTIONS_PER_CAW = 10

  /**
   * Extract @mentions from a caw content. Deduplicated, capped at
   * MAX_MENTIONS_PER_CAW.
   */
  static extractMentions(content: string): string[] {
    const mentionRegex = /@(\w+)/g
    const mentions: string[] = []
    let match

    while ((match = mentionRegex.exec(content)) !== null) {
      mentions.push(match[1])
    }

    const unique = [...new Set(mentions)]
    return unique.slice(0, NotificationService.MAX_MENTIONS_PER_CAW)
  }

  /**
   * Create notifications for @mentions in a caw.
   *
   * Accepts an optional `client` so callers inside an interactive transaction
   * can pass the tx client. The new caw row is only visible inside its own
   * transaction until commit, so writing the FK-bearing notification through
   * the global prisma client races the commit and silently fails for any
   * caw created in this same tx (e.g. cawes ingested via RawEventsGatherer
   * from remote nodes, which have no pre-existing pending row).
   */
  static async createMentionNotifications(cawId: number, content: string, actorId: number, client: Pick<typeof prisma, 'user' | 'notification'> = prisma) {
    const mentions = this.extractMentions(content)

    if (mentions.length === 0) return

    // Find users with mentioned usernames
    const mentionedUsers = await client.user.findMany({
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

    // Idempotency dedupe via groupKey. If this function gets called
    // again for the same caw (action reprocess loop, retry path,
    // cross-mirror relay), each mentioned user already has a row
    // with this groupKey, so we skip — no notification spam. Same
    // pattern as MarketplaceIndexerService SALE_SOLD/SALE_BOUGHT
    // (commit 82831d6).
    //
    // Pre-fix: a single hidden-caw reprocess loop fired 59 mention
    // notifications in 59 minutes for the same caw on test.caw.social
    // before the underlying status-flip-loop was caught.
    const groupKey = `mention_${cawId}`
    if (filteredUsers.length === 0) return

    const existing = await client.notification.findMany({
      where: {
        type: NotificationType.MENTION,
        groupKey,
        userId: { in: filteredUsers.map(u => u.tokenId) },
      },
      select: { userId: true },
    })
    const alreadyNotified = new Set(existing.map(n => n.userId))
    const notifications = filteredUsers
      .filter(user => !alreadyNotified.has(user.tokenId))
      .map(user => ({
        userId: user.tokenId,
        actorId,
        type: NotificationType.MENTION,
        cawId,
        groupKey,
      }))

    if (notifications.length > 0) {
      await client.notification.createMany({
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
   * Create notification for a reply.
   *
   * `client` defaults to the global prisma but callers inside an interactive
   * transaction MUST pass the tx — the notification's FK on `replyCawId`
   * points at a caw that was upserted in the same tx and is invisible to
   * outside connections until commit. See createMentionNotifications for the
   * same pattern.
   */
  static async createReplyNotification(parentCawId: number, replyCawId: number, replierId: number, client: Pick<typeof prisma, 'caw' | 'notification'> = prisma) {
    // Get the parent caw to find its owner
    const parentCaw = await client.caw.findUnique({
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

    // Check if notification already exists to avoid duplicates
    const existing = await client.notification.findFirst({
      where: {
        userId: parentCaw.userId,
        actorId: replierId,
        type: NotificationType.REPLY,
        cawId: replyCawId
      }
    })

    if (!existing) {
      await client.notification.create({
        data: {
          userId: parentCaw.userId,
          actorId: replierId,
          type: NotificationType.REPLY,
          cawId: replyCawId
        }
      })
    }
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

    // Check if notification already exists to avoid duplicates
    const existing = await prisma.notification.findFirst({
      where: {
        userId: originalCaw.userId,
        actorId: reposterId,
        type: NotificationType.REPOST,
        cawId: originalCawId
      }
    })

    if (!existing) {
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
  }

  /**
   * Create notification for a quote.
   *
   * Pass the tx `client` when called from inside an interactive transaction —
   * the FK on `quoteCawId` points at a caw upserted in the same tx. See
   * createMentionNotifications for the same pattern.
   */
  static async createQuoteNotification(originalCawId: number, quoteCawId: number, quoterId: number, client: Pick<typeof prisma, 'caw' | 'notification'> = prisma) {
    // Get the original caw to find its owner
    const originalCaw = await client.caw.findUnique({
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

    // Check if notification already exists to avoid duplicates
    const existing = await client.notification.findFirst({
      where: {
        userId: originalCaw.userId,
        actorId: quoterId,
        type: NotificationType.QUOTE,
        cawId: quoteCawId
      }
    })

    if (!existing) {
      await client.notification.create({
        data: {
          userId: originalCaw.userId,
          actorId: quoterId,
          type: NotificationType.QUOTE,
          cawId: quoteCawId
        }
      })
    }
  }

  /**
   * Create notification for a tip
   */
  static async createTipNotification(recipientId: number, tipperId: number, cawId?: number, amount?: number) {
    // Don't notify for self-tips
    if (recipientId === tipperId) return

    // Check if the recipient has muted or blocked the actor
    if (await this.isUserMutedOrBlocked(recipientId, tipperId)) {
      return
    }

    // Check if notification already exists to avoid duplicates
    const existing = await prisma.notification.findFirst({
      where: {
        userId: recipientId,
        actorId: tipperId,
        type: NotificationType.TIP,
        cawId: cawId || undefined
      }
    })

    if (!existing) {
      await prisma.notification.create({
        data: {
          userId: recipientId,
          actorId: tipperId,
          type: NotificationType.TIP,
          cawId: cawId || undefined,
          groupKey: cawId ? `tip_caw_${cawId}` : undefined,
          actionPayload: amount ? { tipAmount: String(amount) } : undefined,
        }
      })
    }
  }

  /**
   * Mark notifications as read
   */
  static async markAsRead(userId: number, notificationIds?: number[], types?: NotificationType[]) {
    if (notificationIds) {
      // Mark specific notifications as read
      await prisma.notification.updateMany({
        where: {
          id: { in: notificationIds },
          userId
        },
        data: { isRead: true }
      })
    } else if (types && types.length > 0) {
      // Mark all unread notifications of the given types (e.g. clearing a
      // tab-scoped badge like Recent Sales).
      await prisma.notification.updateMany({
        where: { userId, isRead: false, type: { in: types } },
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
        isRead: false,
        hidden: false
      }
    })
  }
}
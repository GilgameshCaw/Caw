import { prisma } from '../prismaClient'
import { NotificationType, Prisma } from '@prisma/client'
import { elasticsearchService } from './ElasticsearchService'

/**
 * Derive the persistent-group `targetKey` for a notification. NULL
 * collapses all rows of this `(userId, type)` into one bucket; a
 * value separates buckets per target.
 *
 *   FOLLOW                                  → null (one bucket per user)
 *   OFFER                                   → offerId.toString()
 *   LIKE / REPOST / QUOTE / TIP / MENTION   → cawId.toString()
 *   REPLY                                   → parentCawId.toString()
 *                                              (NOT the reply's own cawId — that
 *                                              would put every chunk of a multi-
 *                                              part thread reply in its own group;
 *                                              keying by the caw being replied to
 *                                              folds all chunks into one rollup)
 *   ACTION_FAILED                           → null (each row stays alone via
 *                                                   the duplicate-check in
 *                                                   the create call site)
 */
function notificationTargetKey(
  type: NotificationType,
  ctx: { cawId?: number | null; offerId?: number | null; parentCawId?: number | null }
): string | null {
  if (type === NotificationType.FOLLOW || type === NotificationType.ACTION_FAILED) return null
  if (type === NotificationType.OFFER) return ctx.offerId != null ? String(ctx.offerId) : null
  if (type === NotificationType.REPLY) {
    return ctx.parentCawId != null ? String(ctx.parentCawId)
      : (ctx.cawId != null ? String(ctx.cawId) : null)
  }
  return ctx.cawId != null ? String(ctx.cawId) : null
}

/**
 * Create a notification row AND assign it to a NotificationGroup.
 *
 * A group stays open as long as `isRead = false`. Any notification
 * arriving on the same `(userId, type, targetKey)` bucket joins the
 * open group regardless of age. When a user reads the group it closes;
 * the next event on that bucket opens a fresh group.
 *
 * The group upsert is atomic: a single INSERT … ON CONFLICT DO UPDATE
 * prevents the race where two concurrent inserts both see "no open
 * group" and each create their own duplicate.
 *
 * The partial unique index on `(userId, type, COALESCE(targetKey, ''))
 * WHERE isRead = false` enforces at most one open group per bucket.
 * The COALESCE handles the NULL targetKey case (FOLLOW, ACTION_FAILED)
 * since Postgres treats NULLs as distinct in regular unique indexes.
 *
 * Always runs inside the caller's prisma client (so it composes with
 * an outer transaction). The caller must pass a client that supports
 * `notification.create` and `$executeRaw` / `$queryRaw`.
 *
 * Returns the created Notification's id.
 */
export async function createNotificationWithGroup(
  client: { notification: any; notificationGroup: any; $queryRawUnsafe?: any; $queryRaw?: any },
  data: Prisma.NotificationCreateInput | Prisma.NotificationUncheckedCreateInput,
  // Optional grouping context. Currently only REPLY uses parentCawId to
  // bucket by the caw being replied to (instead of by the reply chunk's
  // own id) so multi-part thread replies fold into a single rollup.
  groupCtx?: { parentCawId?: number | null },
): Promise<number> {
  // 1) Insert the notification row first — we need its id to point
  //    the group's `latestNotificationId` at it.
  const notif = await client.notification.create({ data })

  // 2) Decide the bucket key.
  const targetKey = notificationTargetKey(
    notif.type as NotificationType,
    { cawId: notif.cawId, offerId: notif.offerId, parentCawId: groupCtx?.parentCawId },
  )

  // 3) Atomic upsert: if an open group already exists for this
  //    (userId, type, targetKey) bucket, increment its count and
  //    update the latest pointer. Otherwise create a fresh group.
  //
  //    The conflict target matches the partial unique index:
  //      (userId, type, COALESCE(targetKey, '')) WHERE isRead = false
  //
  //    We use $queryRawUnsafe on the tx client (or fall back to the
  //    global prisma) because Prisma has no first-class support for
  //    partial-index ON CONFLICT targets.
  const now = notif.createdAt as Date

  // Resolve to a raw-query-capable client. Interactive-transaction
  // clients expose $executeRaw / $queryRaw but not $queryRawUnsafe;
  // the global prisma exposes all three. We need the RETURNING id so
  // we prefer $queryRawUnsafe when available, otherwise $queryRaw
  // with a tagged-template literal.
  const rawClient = (client as any).$queryRawUnsafe
    ? (client as any)
    : prisma

  const rows: Array<{ id: number }> = await rawClient.$queryRawUnsafe(
    `INSERT INTO "NotificationGroup" (
       "userId", "type", "targetKey", "openedAt", "lastEventAt",
       "isRead", "latestNotificationId", "count"
     ) VALUES ($1, $2::\"NotificationType\", $3, $4, $4, false, $5, 1)
     ON CONFLICT ("userId", "type", COALESCE("targetKey", ''))
       WHERE "isRead" = false
     DO UPDATE SET
       "count"                = "NotificationGroup"."count" + 1,
       "lastEventAt"          = EXCLUDED."lastEventAt",
       "latestNotificationId" = EXCLUDED."latestNotificationId"
     RETURNING id`,
    notif.userId,
    notif.type,
    targetKey,
    now,
    notif.id,
  )

  const groupId = rows[0].id

  // 4) Back-reference the new notification to its group.
  await client.notification.update({
    where: { id: notif.id },
    data: { groupId },
  })

  return notif.id
}

export class NotificationService {
  /** Exposed for tests + the migration backfill path. */
  static _attachToGroup = createNotificationWithGroup
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
  static async createMentionNotifications(cawId: number, content: string, actorId: number, client: Pick<typeof prisma, 'user' | 'notification' | 'notificationGroup'> = prisma) {
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
      // One-by-one through the group-aware helper instead of
      // createMany. Each mention is its own (userId, type, cawId)
      // bucket so the helper opens the right group for each
      // recipient; skipDuplicates is replaced by the
      // findFirst-then-create pattern inside createNotificationWithGroup's
      // callers (mentions don't have a uniqueness constraint so we
      // accept the small race window where two simultaneous indexer
      // runs could double-write — same behavior as before).
      for (const n of notifications) {
        await createNotificationWithGroup(client, n)
      }
    }
  }

  /**
   * Create notification for a follow action.
   *
   * Pass the tx `client` when called from inside an interactive transaction.
   * Skipping this leaks a second pool connection (this method's queries
   * acquire their own connection from the global pool while the caller's
   * tx still holds the first), so concurrent ingest hits P2024 at half
   * the apparent pool size.
   */
  static async createFollowNotification(followedId: number, followerId: number, client: Pick<typeof prisma, 'notification' | 'notificationGroup'> = prisma) {
    // Don't notify if user follows themselves
    if (followedId === followerId) return

    // Check if the recipient has muted or blocked the actor
    if (await this.isUserMutedOrBlocked(followedId, followerId)) {
      return // User is muted/blocked, don't send notification
    }

    // Check if notification already exists to avoid duplicates
    const existing = await client.notification.findFirst({
      where: {
        userId: followedId,
        actorId: followerId,
        type: NotificationType.FOLLOW
      }
    })

    if (!existing) {
      await createNotificationWithGroup(client, {
        userId: followedId,
        actorId: followerId,
        type: NotificationType.FOLLOW,
        groupKey: 'follow',
      })
    }
  }

  /**
   * Create notification for a like action.
   *
   * Pass the tx `client` when called from inside an interactive transaction.
   * Same pool-leak rationale as createFollowNotification.
   */
  static async createLikeNotification(cawId: number, likerId: number, client: Pick<typeof prisma, 'caw' | 'notification' | 'notificationGroup'> = prisma) {
    // Get the caw to find its owner
    const caw = await client.caw.findUnique({
      where: { id: cawId },
      select: { userId: true }
    })

    if (!caw) return
    if (caw.userId === likerId) return // self-like

    // Check if the recipient has muted or blocked the actor
    if (await this.isUserMutedOrBlocked(caw.userId, likerId)) return

    // Check if the recipient has muted this thread
    if (await this.isThreadMutedForUser(caw.userId, cawId)) return

    // Check if notification already exists to avoid duplicates
    const existing = await client.notification.findFirst({
      where: {
        userId: caw.userId,
        actorId: likerId,
        type: NotificationType.LIKE,
        cawId
      }
    })

    if (!existing) {
      await createNotificationWithGroup(client, {
        userId: caw.userId,
        actorId: likerId,
        type: NotificationType.LIKE,
        cawId,
        groupKey: `like_caw_${cawId}`,
      })
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
  static async createReplyNotification(parentCawId: number, replyCawId: number, replierId: number, client: Pick<typeof prisma, 'caw' | 'notification' | 'notificationGroup'> = prisma) {
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
      await createNotificationWithGroup(
        client,
        {
          userId: parentCaw.userId,
          actorId: replierId,
          type: NotificationType.REPLY,
          cawId: replyCawId,
        },
        // Bucket REPLY notifications by the parent caw, so all chunks of
        // a multi-part thread reply fold into one rollup row instead of
        // filling the bell with "(1/6) replied", "(2/6) replied", etc.
        { parentCawId },
      )
    }
  }

  /**
   * Create notification for a repost.
   *
   * Pass the tx `client` when called from inside an interactive transaction.
   * Same pool-leak rationale as createFollowNotification.
   */
  static async createRepostNotification(originalCawId: number, reposterId: number, client: Pick<typeof prisma, 'caw' | 'notification' | 'notificationGroup'> = prisma) {
    // Get the original caw to find its owner
    const originalCaw = await client.caw.findUnique({
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
    const existing = await client.notification.findFirst({
      where: {
        userId: originalCaw.userId,
        actorId: reposterId,
        type: NotificationType.REPOST,
        cawId: originalCawId
      }
    })

    if (!existing) {
      await createNotificationWithGroup(client, {
        userId: originalCaw.userId,
        actorId: reposterId,
        type: NotificationType.REPOST,
        cawId: originalCawId,
        groupKey: `repost_caw_${originalCawId}`,
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
  static async createQuoteNotification(originalCawId: number, quoteCawId: number, quoterId: number, client: Pick<typeof prisma, 'caw' | 'notification' | 'notificationGroup'> = prisma) {
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
      await createNotificationWithGroup(client, {
        userId: originalCaw.userId,
        actorId: quoterId,
        type: NotificationType.QUOTE,
        cawId: quoteCawId,
      })
    }
  }

  /**
   * Create notification for a tip.
   *
   * Pass the tx `client` when called from inside an interactive transaction.
   * Same pool-leak rationale as createFollowNotification.
   */
  static async createTipNotification(recipientId: number, tipperId: number, cawId?: number, amount?: number, client: Pick<typeof prisma, 'notification' | 'notificationGroup'> = prisma) {
    // Don't notify for self-tips
    if (recipientId === tipperId) return

    // Check if the recipient has muted or blocked the actor
    if (await this.isUserMutedOrBlocked(recipientId, tipperId)) {
      return
    }

    // Check if notification already exists to avoid duplicates
    const existing = await client.notification.findFirst({
      where: {
        userId: recipientId,
        actorId: tipperId,
        type: NotificationType.TIP,
        cawId: cawId || undefined
      }
    })

    if (!existing) {
      await createNotificationWithGroup(client, {
        userId: recipientId,
        actorId: tipperId,
        type: NotificationType.TIP,
        cawId: cawId || undefined,
        groupKey: cawId ? `tip_caw_${cawId}` : undefined,
        actionPayload: amount ? { tipAmount: String(amount) } : undefined,
      })
    }
  }

  /**
   * Create notification for a vote on the recipient's poll.
   *
   * The poll's owner is the recipient. groupKey is keyed by the
   * caw the poll lives on, so multiple voters on the same poll
   * collapse to one notification row at read time. Idempotent vote
   * changes (single-select user changing their pick) hit the
   * findFirst dedupe and skip a duplicate notification — they only
   * cost one notification per (poll, voter) pair.
   *
   * Pass the tx `client` when called from inside an interactive
   * transaction. Same pool-leak rationale as createFollowNotification.
   */
  static async createVoteNotification(
    cawId: number,
    pollOwnerId: number,
    voterId: number,
    client: Pick<typeof prisma, 'notification' | 'notificationGroup'> = prisma,
  ) {
    if (pollOwnerId === voterId) return  // self-vote, no notification
    if (await this.isUserMutedOrBlocked(pollOwnerId, voterId)) return

    // Dedupe: one VOTE notification per (poll-author, voter, poll).
    // Single-select polls with vote-changing only emit one row total;
    // multi-select polls likewise — additional toggles by the same
    // voter on the same poll don't spam a fresh notification.
    const existing = await client.notification.findFirst({
      where: {
        userId: pollOwnerId,
        actorId: voterId,
        type: NotificationType.VOTE,
        cawId,
      },
    })
    if (existing) return

    await createNotificationWithGroup(client, {
      userId: pollOwnerId,
      actorId: voterId,
      type: NotificationType.VOTE,
      cawId,
      groupKey: `vote_caw_${cawId}`,
    })
  }

  /**
   * Mark notifications as read
   */
  static async markAsRead(userId: number, notificationIds?: number[], types?: NotificationType[]) {
    if (notificationIds) {
      // Mark specific notifications as read. Also flip every NotificationGroup
      // those rows belong to — a group is read iff all its members are.
      // Closing a group like this is what causes the next event to open a
      // fresh group (the open-window check requires isRead=false to join).
      const rows = await prisma.notification.findMany({
        where: { id: { in: notificationIds }, userId },
        select: { groupId: true },
      })
      await prisma.notification.updateMany({
        where: { id: { in: notificationIds }, userId },
        data: { isRead: true }
      })
      const affectedGroupIds = Array.from(new Set(rows.map(r => r.groupId).filter((x): x is number => x != null)))
      if (affectedGroupIds.length > 0) {
        // Only flip a group read when ALL its members are now read.
        // For partial-read groups (user clicked individual rows), keep
        // them unread so the bell badge stays accurate.
        await prisma.$executeRaw`
          UPDATE "NotificationGroup" g
          SET "isRead" = true
          WHERE g.id = ANY(${affectedGroupIds}::int[])
            AND NOT EXISTS (
              SELECT 1 FROM "Notification" n
              WHERE n."groupId" = g.id AND n."isRead" = false
            )
        `
      }
    } else if (types && types.length > 0) {
      // Tab-scoped clear: mark all unread of these types read at both
      // the notification level and the group level.
      await prisma.notification.updateMany({
        where: { userId, isRead: false, type: { in: types } },
        data: { isRead: true }
      })
      await prisma.notificationGroup.updateMany({
        where: { userId, isRead: false, type: { in: types } },
        data: { isRead: true },
      })
    } else {
      // Mark-all-read: flip every unread row and every unread group.
      await prisma.notification.updateMany({
        where: { userId, isRead: false },
        data: { isRead: true }
      })
      await prisma.notificationGroup.updateMany({
        where: { userId, isRead: false },
        data: { isRead: true },
      })
    }
  }

  /**
   * Get unread notification count. Returns the count of unread GROUPS —
   * that's what the bell badge displays (one entry per group on the
   * feed).
   */
  static async getUnreadCount(userId: number): Promise<number> {
    return await prisma.notificationGroup.count({
      where: { userId, isRead: false }
    })
  }
}
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
router.get('/', requireAuth({ lookup: async (req) => Number(req.query.userId) || undefined, verifyOwnership: true }), async (req, res) => {
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

    // Resolve the type filter once — Prisma where AND raw SQL WHERE both
    // need it.
    let typeFilter: NotificationType | null = null
    if (type && type !== 'all') {
      if (type === 'mentions') typeFilter = NotificationType.MENTION
      else if (Object.values(NotificationType).includes(type as NotificationType)) {
        typeFilter = type as NotificationType
      }
    }

    // Group-aware pagination.
    //
    // The previous version used offset-based pagination of RAW rows then
    // grouped each page in memory. That broke for any group that spanned
    // a page boundary: the SAME FOLLOW rollup showed up on every Load
    // More with a different lead-name, because each page sliced a
    // different subset of the same 'follow' bucket (bug reported with
    // 99 unread + 3 visible groups repeating forever).
    //
    // Fix: paginate by GROUP, not by row. Each group is identified by
    // `groupKey` (rows without one get a per-row synthetic key
    // `single:<id>`). The aggregation picks each group's most-recent
    // notification id as the representative; downstream code fetches
    // that row plus the additional-actor metadata.
    type GroupRow = {
      group_key: string
      latest_id: number
      latest_created_at: Date
      total_count: bigint
      any_unread: boolean
    }
    // Build the SQL + params dynamically so optional filters (blocked
    // actors, type, unread-only) only add WHERE clauses when active.
    // Param order: userTokenId, then optional typeFilter, then limit
    // + offset, then optional blocked ids tail.
    const params: any[] = [userTokenId]
    const whereParts: string[] = [`"userId" = $1`, `hidden = false`]
    if (typeFilter) {
      params.push(typeFilter)
      whereParts.push(`type::text = $${params.length}`)
    }
    if (unreadOnly === 'true') {
      whereParts.push(`"isRead" = false`)
    }
    if (blockedIds.length > 0) {
      const startIdx = params.length + 1
      const placeholders = blockedIds.map((_, i) => `$${startIdx + i}`).join(',')
      whereParts.push(`"actorId" NOT IN (${placeholders})`)
      params.push(...blockedIds)
    }
    // LIMIT + OFFSET go last so we can append them after the variable
    // WHERE tail without re-numbering.
    params.push(notificationLimit, notificationOffset)
    const limitIdx = params.length - 1
    const offsetIdx = params.length

    const groupsRaw = await prisma.$queryRawUnsafe<GroupRow[]>(`
      SELECT
        COALESCE("groupKey", 'single:' || id::text) AS group_key,
        MAX(id) AS latest_id,
        MAX("createdAt") AS latest_created_at,
        COUNT(*) AS total_count,
        bool_or(NOT "isRead") AS any_unread
      FROM "Notification"
      WHERE ${whereParts.join(' AND ')}
      GROUP BY group_key
      ORDER BY latest_created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `, ...params)

    // No groups → nothing to render. Short-circuit out without the
    // downstream relation fetches.
    if (groupsRaw.length === 0) {
      const unreadWhereEmpty: any = { userId: userTokenId, isRead: false, hidden: false }
      if (blockedIds.length > 0) unreadWhereEmpty.actorId = { notIn: blockedIds }
      const emptyCount = await prisma.notification.count({ where: unreadWhereEmpty })
      return res.json({ notifications: [], unreadCount: emptyCount, hasMore: false })
    }

    // Fetch the representative row (the latest one in each group) for
    // rendering. This gives us the actor/caw/offer relations for the
    // group's lead notification — the one whose name appears first in
    // "Liam and 4 others liked your caw".
    const latestIds = groupsRaw.map(g => g.latest_id)
    const notifications = await prisma.notification.findMany({
      where: { id: { in: latestIds } },
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
            createdAt: true,
            // Media bits so the notification row can render a thumbnail
            // and the renderer can scrub the embedded GIF URL out of the
            // content snippet. Same shape FeedItem uses.
            hasImage: true,
            hasVideo: true,
            imageData: true,
            videoData: true,
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

    // Pull the next ~10 distinct actors per group for the rollup
    // additionalActors array. The modal that opens on click loads the
    // full list separately via /api/notifications/group-actors; here we
    // just want enough to drive count > 1 and the avatar stack.
    const groupKeysForActors = groupsRaw
      .filter(g => g.total_count > 1n && !g.group_key.startsWith('single:'))
      .map(g => g.group_key)
    type ExtraActorRow = {
      groupKey: string
      actorId: number
      username: string
      displayName: string | null
      avatarUrl: string | null
      defaultAvatarId: number | null
    }
    const extraActorsByGroup = new Map<string, ExtraActorRow[]>()
    if (groupKeysForActors.length > 0) {
      const extras = await prisma.$queryRawUnsafe<ExtraActorRow[]>(`
        SELECT DISTINCT ON (n."groupKey", u."tokenId")
          n."groupKey" AS "groupKey",
          u."tokenId" AS "actorId",
          u.username,
          u."displayName",
          u."avatarUrl",
          u."defaultAvatarId"
        FROM "Notification" n
        JOIN "User" u ON u."tokenId" = n."actorId"
        WHERE n."userId" = $1
          AND n.hidden = false
          AND n."groupKey" = ANY($2::text[])
          AND n.id <> ALL($3::int[])
        ORDER BY n."groupKey", u."tokenId", n."createdAt" DESC
      `, userTokenId, groupKeysForActors, latestIds)
      for (const e of extras) {
        const arr = extraActorsByGroup.get(e.groupKey) ?? []
        if (arr.length < 50) arr.push(e)
        extraActorsByGroup.set(e.groupKey, arr)
      }
    }

    // Build a quick lookup for group metadata by groupKey so the merge
    // loop below can stamp count + any_unread on each notification.
    const groupMetaByKey = new Map<string, GroupRow>()
    for (const g of groupsRaw) groupMetaByKey.set(g.group_key, g)
    const groupKeyForNotif = (n: { id: number; groupKey: string | null }) =>
      n.groupKey ?? `single:${n.id}`

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

    // Merge SQL group metadata into each notification row. Each
    // notification represents ONE group (its latest member); the
    // group-level count + actor list come from the aggregation
    // queries above. ACTION_FAILED rows still get their payload
    // enriched the same way as before.
    const groupedNotifications: any[] = []

    for (const notification of notifications) {
      const gk = groupKeyForNotif(notification)
      const meta = groupMetaByKey.get(gk)
      const totalCount = meta ? Number(meta.total_count) : 1
      const anyUnread = meta ? meta.any_unread : !notification.isRead

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

      const additionalActors = totalCount > 1
        ? (extraActorsByGroup.get(gk) || []).map(a => ({
            tokenId: a.actorId,
            username: a.username,
            displayName: a.displayName ?? undefined,
            avatarUrl: a.avatarUrl ?? undefined,
            defaultAvatarId: a.defaultAvatarId ?? undefined,
          }))
        : []

      groupedNotifications.push({
        id: notification.id,
        type: notification.type,
        actor: notification.actor,
        additionalActors,
        caw: notification.caw,
        offer: (notification as any).offer || null,
        actionPayload,
        isRead: !anyUnread,
        createdAt: notification.createdAt,
        count: totalCount,
        groupKey: notification.groupKey ?? null,
        notificationIds: [notification.id],
      })
    }

    // groupedNotifications is already in descending createdAt order
    // because the SQL aggregation sorted by latest_created_at DESC and
    // we fetched notifications in that order.

    // Get unread count (also filtered by blocked users)
    const unreadWhere: any = { userId: userTokenId, isRead: false, hidden: false }
    if (blockedIds.length > 0) {
      unreadWhere.actorId = { notIn: blockedIds }
    }
    const unreadCount = await prisma.notification.count({ where: unreadWhere })

    return res.json({
      notifications: groupedNotifications,
      unreadCount,
      // hasMore is based on GROUPS now, not raw rows. If the SQL group
      // query returned exactly notificationLimit groups, there may be
      // more groups behind the cursor.
      hasMore: groupsRaw.length === notificationLimit
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
router.get('/unread-count', requireAuth({ lookup: async (req) => Number(req.query.userId) || undefined, verifyOwnership: true }), async (req, res) => {
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
 * GET /api/notifications/group-actors
 * Paginate the full actor list for a notification group beyond the 50 inlined
 * in the main notifications response.
 *
 * Query params:
 *   userId    – REQUIRED. Must match the authenticated session's tokenId.
 *   groupKey  – REQUIRED. Literal grouping key, e.g. 'follow' or 'like_caw_42'.
 *   type      – REQUIRED. NotificationType string, e.g. 'FOLLOW' or 'LIKE'.
 *   cursor    – optional. Opaque: "<createdAt ISO>_<notificationId>" of the last
 *               returned row. Omit for the first page.
 *   limit     – optional. Default 50, max 100.
 */
router.get('/group-actors', requireAuth({ lookup: async (req) => Number(req.query.userId) || undefined, verifyOwnership: true }), async (req, res) => {
  try {
    const { userId, groupKey, type, cursor, limit: limitParam } = req.query

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' })
    }
    if (!groupKey) {
      return res.status(400).json({ error: 'groupKey is required' })
    }
    if (!type) {
      return res.status(400).json({ error: 'type is required' })
    }

    const userTokenId = Number(userId)
    if (!Number.isFinite(userTokenId) || userTokenId === 0) {
      return res.status(400).json({ error: 'Invalid userId' })
    }

    // Validate type is a known NotificationType
    if (!Object.values(NotificationType).includes(type as NotificationType)) {
      return res.status(400).json({ error: 'Invalid notification type' })
    }

    const limit = Math.min(Number(limitParam) || 50, 100)

    // Parse cursor: "<createdAt ISO>_<notificationId>"
    let cursorWhere: any = undefined
    if (cursor && typeof cursor === 'string') {
      const parts = cursor.split('_')
      const cursorId = Number(parts[parts.length - 1])
      const cursorDate = new Date(parts.slice(0, -1).join('_'))
      if (Number.isFinite(cursorId) && !isNaN(cursorDate.getTime())) {
        cursorWhere = {
          OR: [
            { createdAt: { lt: cursorDate } },
            { createdAt: cursorDate, id: { lt: cursorId } }
          ]
        }
      }
    }

    const notifications = await prisma.notification.findMany({
      where: {
        userId: userTokenId,
        type: type as NotificationType,
        groupKey: groupKey as string,
        hidden: false,
        ...(cursorWhere ?? {})
      },
      take: limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        actor: {
          select: {
            tokenId: true,
            username: true,
            displayName: true,
            avatarUrl: true,
            defaultAvatarId: true
          }
        }
      }
    })

    const hasMore = notifications.length > limit
    const page = notifications.slice(0, limit)

    let nextCursor: string | undefined
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1]
      nextCursor = `${last.createdAt.toISOString()}_${last.id}`
    }

    const actors = page.map(n => ({
      tokenId: n.actor.tokenId,
      username: n.actor.username,
      displayName: n.actor.displayName,
      avatarUrl: n.actor.avatarUrl,
      defaultAvatarId: (n.actor as any).defaultAvatarId ?? 0
    }))

    return res.json({ actors, nextCursor })

  } catch (error) {
    console.error('GET /api/notifications/group-actors error:', error)
    return res.status(500).json({ error: 'Failed to get group actors' })
  }
})

/**
 * POST /api/notifications/read
 * Mark notifications as read
 */
router.post('/read', requireAuth({ field: 'userId', verifyOwnership: true }), async (req, res) => {
  try {
    const { userId, notificationIds, types } = req.body

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' })
    }

    const userTokenId = parseInt(userId)

    // If notificationIds provided → mark those specific ones.
    // Else if types provided → mark all unread of those types (tab-scoped clear).
    // Else → mark all as read for the user.
    await NotificationService.markAsRead(userTokenId, notificationIds, types)

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
router.patch('/:id/hide', requireAuth({ field: 'userId', verifyOwnership: true }), async (req, res) => {
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
router.post('/hide-by-original-tx', requireAuth({ field: 'userId', verifyOwnership: true }), async (req, res) => {
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
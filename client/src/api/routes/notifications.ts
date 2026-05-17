import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { NotificationService, createNotificationWithGroup } from '../../services/NotificationService'
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

    // Read path: NotificationGroup is the authoritative feed.
    //
    // Per group:
    //   - one row in NotificationGroup with count, lastEventAt,
    //     isRead, latestNotificationId
    //   - many rows in Notification linked via groupId, each with its
    //     own actor (the people who liked / followed / etc.)
    //
    // We paginate over groups (LIMIT/OFFSET on the indexed lastEventAt
    // DESC scan), then fetch each group's latest notification + a few
    // additional actors for the rollup stack. Read is O(group page
    // size) — no aggregation per request.

    const groupWhere: any = { userId: userTokenId }
    if (typeFilter) groupWhere.type = typeFilter
    if (unreadOnly === 'true') groupWhere.isRead = false

    const groups = await prisma.notificationGroup.findMany({
      where: groupWhere,
      orderBy: { lastEventAt: 'desc' },
      take: notificationLimit,
      skip: notificationOffset,
      select: {
        id: true,
        type: true,
        targetKey: true,
        count: true,
        isRead: true,
        lastEventAt: true,
        openedAt: true,
        latestNotificationId: true,
      },
    })

    if (groups.length === 0) {
      // Count of unread GROUPS (not raw rows) — matches what the bell
      // badge should display now that the feed is group-paginated.
      const unreadWhereEmpty: any = { userId: userTokenId, isRead: false }
      const emptyCount = await prisma.notificationGroup.count({ where: unreadWhereEmpty })
      return res.json({ notifications: [], unreadCount: emptyCount, hasMore: false })
    }

    // Fetch the representative notification (the group's latest member)
    // for each group, with the actor / caw / offer relations needed to
    // render the row. blockedIds is applied here as a post-filter rather
    // than baked into the group query — a blocked actor's most recent
    // event might still be the group's latest; if the entire group is
    // from blocked actors we'll just render an empty actor below and
    // the UI will skip it.
    const latestIds = groups.map(g => g.latestNotificationId)
    const notifications = await prisma.notification.findMany({
      where: {
        id: { in: latestIds },
        ...(blockedIds.length > 0 ? { actorId: { notIn: blockedIds } } : {}),
      },
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
            // Poll core — options + totalVotes for PollMiniResults.
            // Per-option vote counts are filled in below via a grouped
            // Vote query. userVote is omitted: the notification recipient
            // is the poll author, not a voter.
            poll: {
              select: {
                id: true,
                options: true,
                totalVotes: true,
                endsAt: true,
              }
            }
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

    // Pull a few distinct extra actors per multi-member group for the
    // rollup avatar stack. Single-row groups skip this entirely.
    const multiGroupIds = groups.filter(g => g.count > 1).map(g => g.id)
    type ExtraActorRow = {
      groupId: number
      actorId: number
      username: string
      displayName: string | null
      avatarUrl: string | null
      defaultAvatarId: number | null
    }
    const extraActorsByGroup = new Map<number, ExtraActorRow[]>()
    if (multiGroupIds.length > 0) {
      const extras = await prisma.$queryRawUnsafe<ExtraActorRow[]>(`
        SELECT DISTINCT ON (n."groupId", u."tokenId")
          n."groupId" AS "groupId",
          u."tokenId" AS "actorId",
          u.username,
          u."displayName",
          u."avatarUrl",
          u."defaultAvatarId"
        FROM "Notification" n
        JOIN "User" u ON u."tokenId" = n."actorId"
        WHERE n."groupId" = ANY($1::int[])
          AND n.id <> ALL($2::int[])
          ${blockedIds.length > 0 ? `AND n."actorId" NOT IN (${blockedIds.map((_, i) => `$${i + 3}`).join(',')})` : ''}
        ORDER BY n."groupId", u."tokenId", n."createdAt" DESC
      `, multiGroupIds, latestIds, ...blockedIds)
      for (const e of extras) {
        const arr = extraActorsByGroup.get(e.groupId) ?? []
        if (arr.length < 50) arr.push(e)
        extraActorsByGroup.set(e.groupId, arr)
      }
    }

    // Pair each notification with its group metadata for the merge
    // loop below.
    const groupByLatestId = new Map<number, typeof groups[number]>()
    for (const g of groups) groupByLatestId.set(g.latestNotificationId, g)

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

    // Enrich poll vote counts for any notification whose caw has a poll.
    // We collect all poll IDs across the page, do a single grouped Vote
    // query, then attach optionVoteCounts to each caw.poll. userVote is
    // not surfaced here — the recipient is the poll author, not a voter.
    const pollIdsByCawId = new Map<number, number>()
    for (const n of notifications) {
      const caw = (n as any).caw
      if (caw?.poll?.id) pollIdsByCawId.set(caw.id, caw.poll.id)
    }
    const pollVoteCountsByPollId = new Map<number, number[]>()
    if (pollIdsByCawId.size > 0) {
      const pollIds = Array.from(new Set(pollIdsByCawId.values()))
      const voteCounts = await prisma.vote.groupBy({
        by: ['pollId', 'optionIndex'],
        where: { pollId: { in: pollIds }, pending: false },
        _count: { id: true },
      })
      for (const row of voteCounts) {
        const arr = pollVoteCountsByPollId.get(row.pollId) ?? []
        arr[row.optionIndex] = row._count.id
        pollVoteCountsByPollId.set(row.pollId, arr)
      }
    }

    // Merge SQL group metadata into each notification row. Each
    // notification represents ONE group (its latest member); the
    // group-level count + actor list come from the aggregation
    // queries above. ACTION_FAILED rows still get their payload
    // enriched the same way as before.
    const groupedNotifications: any[] = []

    for (const notification of notifications) {
      const group = groupByLatestId.get(notification.id)
      const totalCount = group ? group.count : 1
      const groupIsRead = group ? group.isRead : notification.isRead

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

      const additionalActors = group && totalCount > 1
        ? (extraActorsByGroup.get(group.id) || []).map(a => ({
            tokenId: a.actorId,
            username: a.username,
            displayName: a.displayName ?? undefined,
            avatarUrl: a.avatarUrl ?? undefined,
            defaultAvatarId: a.defaultAvatarId ?? undefined,
          }))
        : []

      // Attach per-option vote counts to caw.poll when present.
      let cawOut: any = notification.caw
      if (cawOut?.poll) {
        const pollId = cawOut.poll.id
        const rawCounts = pollVoteCountsByPollId.get(pollId) ?? []
        const optionsLen: number = cawOut.poll.options?.length ?? 0
        const optionVoteCounts: number[] = []
        for (let i = 0; i < optionsLen; i++) optionVoteCounts.push(rawCounts[i] ?? 0)
        cawOut = {
          ...cawOut,
          poll: {
            options: cawOut.poll.options,
            totalVotes: cawOut.poll.totalVotes ?? 0,
            optionVoteCounts,
            endsAt: cawOut.poll.endsAt ? cawOut.poll.endsAt.toISOString() : null,
            userVote: null,
            userVotes: [],
          }
        }
      }

      groupedNotifications.push({
        id: notification.id,
        type: notification.type,
        actor: notification.actor,
        additionalActors,
        caw: cawOut,
        offer: (notification as any).offer || null,
        actionPayload,
        isRead: groupIsRead,
        createdAt: notification.createdAt,
        count: totalCount,
        groupKey: notification.groupKey ?? null,
        notificationIds: [notification.id],
      })
    }

    // groupedNotifications inherits the lastEventAt DESC order from the
    // NotificationGroup query above. Sort again here as a safety net in
    // case the blocked-actor filter rearranged anything.
    groupedNotifications.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )

    // Bell-badge count = unread GROUPS (the bell shows "you have N
    // unread rollups", not "N raw notifications"). The /unread-count
    // route below shares this definition.
    const unreadGroupCount = await prisma.notificationGroup.count({
      where: { userId: userTokenId, isRead: false },
    })

    return res.json({
      notifications: groupedNotifications,
      unreadCount: unreadGroupCount,
      // hasMore is based on GROUPS. If the page returned exactly
      // notificationLimit groups, there may be more behind the cursor.
      hasMore: groups.length === notificationLimit,
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

    // Count unread GROUPS (matches the bell-badge semantic in the
    // notifications list). Single indexed lookup on
    // NotificationGroup(userId, isRead, lastEventAt).
    const unreadCount = await prisma.notificationGroup.count({
      where: { userId: userTokenId, isRead: false },
    })

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

    const notificationId = await createNotificationWithGroup(prisma, {
      userId: parseInt(userId),
      actorId: parseInt(actorId),
      type: type as NotificationType,
      cawId: cawId ? parseInt(cawId) : undefined,
    })

    return res.json({ notificationId })

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
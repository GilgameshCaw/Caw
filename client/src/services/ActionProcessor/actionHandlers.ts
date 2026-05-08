// src/services/ActionProcessor/actionHandlers.ts
import { prisma } from '../../prismaClient'
import { findOrCreateUser } from '../UserService'
import { processHashtagsForCaw } from '../../tools/hashtags'
import { NotificationService } from '../NotificationService'
import { elasticsearchService } from '../ElasticsearchService'
import { countManager } from '../CountManager'
import { parsePoll, parseVoteText, resolvePollImageUrl } from '../../tools/pollMarker'
import { markOrphansInImageData } from '../../api/util/orphanedMedia'
import type { PrismaTransactionClient } from './types'

/** Sentinel thrown by findCawId so callers (and the top-level
 *  handleRawAction error handler) can distinguish "indexer doesn't have
 *  this target row" from a real bug. The most common cause is that the
 *  target was created against a different node's database — i.e. fresh
 *  local node looking at chain history that includes likes/replies/tips
 *  for caws that were authored on production, or events from another
 *  clientId that we filter out. We don't want this to spew red errors
 *  in those cases. */
export class CawNotFoundError extends Error {
  constructor(public userId: number, public cawonce: number) {
    super(`target caw not found ${userId} cawonce: ${cawonce}`)
    this.name = 'CawNotFoundError'
  }
}

/**
 * Helper function to find a caw by cawonce and user.
 *
 * Don't filter by action: every Caw row (CAW, RECAW/quote) is uniquely keyed
 * by (userId, cawonce), and quotes are valid targets for replies, likes, and
 * tips just like original posts — filtering to action='CAW' would silently
 * miss them on the indexer and leave Tip.cawId / Reply.cawId / Like.cawId
 * null forever for any interaction with a quote.
 */
export async function findCawId(cawonce: number, userOnChain: number): Promise<number> {
  const uid = await findOrCreateUser(userOnChain)
  const c = await prisma.caw.findUnique({
    where: { userId_cawonce: { userId: uid, cawonce } }
  })
  if (!c) throw new CawNotFoundError(uid, cawonce)
  return c.id
}

/**
 * Handle CAW action - create new caw, process hashtags, update counts
 * May include off-chain image URLs in the text
 */
export async function handleCawAction(
  tx: PrismaTransactionClient,
  action: any,
  rawAction: any,
  authorId: number,
  parentCawId?: number
): Promise<void> {
  // Extract image and video URLs from text if present.
  //
  // Host-tolerant by design: a caw posted on mirror A may carry an
  // s.caw.social URL written by mirror B's upload route, and viewers on
  // mirror C still need to render it. The path shape is what we
  // validate (matches the upload route's `<8hex>.<ext>` filename
  // convention) — same approach pollMarker.ts and the poll-image
  // sanitizer take for the same reason.
  //
  // Bare URL on the video side — no `video:` prefix — because no client
  // (PostForm, /api/actions, scripts) emits one. The previous
  // prefix-required regex silently dropped every video into raw text,
  // leaving hasVideo=false on every video post.
  const imageUrlRegex = /(https?:\/\/[^\s]+\/uploads\/images\/[^\s]+\.(jpg|jpeg|png|gif|webp))/gi
  const imageUrls = rawAction.text?.match(imageUrlRegex) || []

  const videoUrlRegex = /(https?:\/\/[^\s]+\/uploads\/videos\/[^\s]+\.(mp4|webm|mov|avi|mkv|ogg|ogv))/gi
  const videoUrls = rawAction.text?.match(videoUrlRegex) || []

  // Remove image and video URLs from the text content for cleaner display
  let textContent = rawAction.text
  if (imageUrls.length > 0) {
    imageUrls.forEach((url: string) => {
      textContent = textContent.replace(url, '').trim()
    })
  }
  if (videoUrls.length > 0) {
    videoUrls.forEach((url: string) => {
      textContent = textContent.replace(url, '').trim()
    })
  }
  // Clean up any extra newlines left behind
  if (imageUrls.length > 0 || videoUrls.length > 0) {
    textContent = textContent.replace(/\n{3,}/g, '\n\n').trim()
  }

  // Check if a pending caw already exists (optimistic counts were already incremented)
  const existingPendingCaw = await tx.caw.findUnique({
    where: { userId_cawonce: { userId: authorId, cawonce: action.cawonce } },
    select: { status: true }
  })
  const wasPendingCaw = existingPendingCaw?.status === 'PENDING'

  // Use upsert to prevent duplicate CAWs.
  //
  // The update branch ONLY runs when the existing row is PENDING (the
  // optimistic FE-side row waiting for chain confirmation) — if we
  // reach this code with an existing row at all, checkCawExists in
  // domainObjectChecks.ts already returned false, which only happens
  // for PENDING. But before tightening that check, this update branch
  // could fire on a SUCCESS-or-HIDDEN caw and clobber its status. The
  // double-write defense here is intentional belt-and-braces: if a
  // future code path manages to re-enter handleCawAction for a non-
  // PENDING row, we won't undo a hide.
  const newCaw = await tx.caw.upsert({
    where: {
      userId_cawonce: {
        userId: authorId,
        cawonce: action.cawonce
      }
    },
    update: {
      // Only write the on-chain-confirmed fields and ONLY flip status
      // SUCCESS when the row was PENDING. The conditional set is via
      // a Prisma raw expression — Prisma's typed update doesn't have
      // a "set this to X if current is Y" primitive, so we read the
      // existing status earlier (wasPendingCaw) and gate this write.
      content: textContent,
      action: action.actionType,
      originalCawId: parentCawId,
      imageData: imageUrls.length > 0 ? `urls:${imageUrls.join('|||')}` : null,
      hasImage: imageUrls.length > 0,
      videoData: videoUrls.length > 0 ? videoUrls.join('|||') : null,
      hasVideo: videoUrls.length > 0,
      ...(wasPendingCaw ? { status: 'SUCCESS' as const } : {}),
      updatedAt: new Date()
    },
    create: {
      userId: authorId,
      cawonce: action.cawonce,
      content: textContent,
      action: action.actionType,
      originalCawId: parentCawId,
      // Store URLs in imageData field for off-chain images
      imageData: imageUrls.length > 0 ? `urls:${imageUrls.join('|||')}` : null,
      hasImage: imageUrls.length > 0,
      // Store video URLs in videoData field
      videoData: videoUrls.length > 0 ? videoUrls.join('|||') : null,
      hasVideo: videoUrls.length > 0,
      status: 'SUCCESS' // Mark as SUCCESS when created from blockchain event
    }
  })

  // Debug logging for video storage
  if (videoUrls.length > 0) {
    console.log('Stored caw with video:', {
      cawId: newCaw.id,
      hasVideo: newCaw.hasVideo,
      videoData: newCaw.videoData
    })
  }

  // Process hashtags for the new caw
  try {
    await processHashtagsForCaw(newCaw.id, textContent, tx)
  } catch (err) {
    console.error(`Failed to process hashtags for caw ${newCaw.id}:`, err)
    // Don't fail the entire transaction if hashtag processing fails
  }

  // Create notifications for @mentions — pass tx so the FK to newCaw resolves
  // (newCaw is only visible inside this transaction until commit)
  try {
    await NotificationService.createMentionNotifications(newCaw.id, textContent, authorId, tx)
  } catch (err) {
    console.error(`Failed to create mention notifications for caw ${newCaw.id}:`, err)
  }

  // Create the Poll row if the caw text contains a ::poll:...:: marker.
  // Use upsert so the local-API optimistic path (which already created the
  // poll when the user submitted) doesn't conflict with the indexer's
  // catch-up — both paths arrive at the same final row.
  //
  // optionImages: ALWAYS reconstruct from the on-chain marker. The marker
  // now carries host + optional port + optional http flag (see pollMarker.ts
  // for the ::pi:host[:p<N>][:s]:hash::hash:: format), so resolvePollImageUrl
  // produces a working URL for both prod (default-port https — most caws)
  // and dev (local.caw.com:5274 over http). The marker is the source of
  // truth — same on every mirror — so writing it to optionImages on every
  // upsert keeps origin and mirror nodes in sync.
  try {
    const parsedPoll = parsePoll(textContent)
    if (parsedPoll) {
      const reconstructedImages = parsedPoll.imageHashes.map(h =>
        h && parsedPoll.imageHost
          ? resolvePollImageUrl(parsedPoll.imageHost, h, 'webp', parsedPoll.imagePort, parsedPoll.imageScheme)
          : ''
      )
      await tx.poll.upsert({
        where: { cawId: newCaw.id },
        update: {
          options: parsedPoll.options,
          optionImages: reconstructedImages,
        },
        create: {
          cawId: newCaw.id,
          options: parsedPoll.options,
          optionImages: reconstructedImages,
        },
      })
    }
  } catch (err) {
    console.error(`Failed to create poll for caw ${newCaw.id}:`, err)
  }

  // Create notification and confirm Reply record if this references a parent caw
  let isReplyNotQuote = false
  let replyWasPending = false
  if (parentCawId && newCaw) {
    // Check if a Reply record exists — if so, it's a reply; otherwise it's a quote
    const replyRecord = await tx.reply.findFirst({
      where: { replyCawId: newCaw.id }
    })

    if (replyRecord) {
      isReplyNotQuote = true
      replyWasPending = replyRecord.pending
      // It's a reply — confirm pending Reply record and send REPLY notification
      try {
        await tx.reply.updateMany({
          where: {
            replyCawId: newCaw.id,
            pending: true
          },
          data: { pending: false }
        })
        console.log(`[handleCawAction] Confirmed Reply record for replyCawId=${newCaw.id}`)
      } catch (replyErr) {
        console.error('Failed to confirm Reply record:', replyErr)
      }

      try {
        await NotificationService.createReplyNotification(parentCawId, newCaw.id, authorId, tx)
      } catch (err) {
        console.error(`Failed to create reply notification for caw ${newCaw.id}:`, err)
      }
    } else if (action.actionType === 'CAW' || action.actionType === 0) {
      // No Reply record but actionType is CAW (not RECAW) — this is a reply
      // that wasn't created optimistically (e.g. DB rebuild from on-chain events).
      // Create the Reply record now.
      isReplyNotQuote = true
      try {
        await tx.reply.create({
          data: {
            userId: authorId,
            cawId: parentCawId,
            replyCawId: newCaw.id,
            pending: false,
          }
        })
        console.log(`[handleCawAction] Created Reply record from on-chain event: replyCawId=${newCaw.id}, parentCawId=${parentCawId}`)
      } catch (replyErr: any) {
        // Unique constraint violation is fine — means it already exists
        if (replyErr?.code !== 'P2002') {
          console.error('Failed to create Reply record from event:', replyErr)
        }
      }

      try {
        await NotificationService.createReplyNotification(parentCawId, newCaw.id, authorId, tx)
      } catch (err) {
        console.error(`Failed to create reply notification for caw ${newCaw.id}:`, err)
      }
    } else {
      // It's a quote (RECAW with parent) — recawCount on parent is handled by onCawCreated below
      try {
        await NotificationService.createQuoteNotification(parentCawId, newCaw.id, authorId, tx)
      } catch (err) {
        console.error(`Failed to create quote notification for caw ${newCaw.id}:`, err)
      }
    }
  }

  // Increment user's caw count + parent recawCount for quotes (skip if confirming a pending caw).
  // For replies, do NOT pass originalCawId — onCawCreated would bump recawCount on the parent,
  // but replies only affect commentCount (handled separately below).
  const quoteOriginalCawId = (parentCawId && !isReplyNotQuote) ? parentCawId : null
  if (!wasPendingCaw) {
    await countManager.onCawCreated(tx, {
      id: newCaw.id,
      userId: authorId,
      action: 'CAW',
      originalCawId: quoteOriginalCawId,
      status: 'SUCCESS',
    })
  } else {
    // Was pending — counts already set optimistically, just log the no-op
    await countManager.onStatusChanged(tx, 'caw', newCaw.id, 'PENDING', 'SUCCESS', {
      userId: authorId, action: 'CAW', originalCawId: quoteOriginalCawId,
    })
  }

  // Only bump comment count for actual replies, not quotes
  // Skip if the reply was pending — commentCount was already optimistically incremented
  if (parentCawId && isReplyNotQuote && !replyWasPending) {
    await countManager.onReplyCreated(tx, {
      cawId: parentCawId,
      replyCawId: newCaw.id,
      pending: false,
    })
  } else if (parentCawId && isReplyNotQuote && replyWasPending) {
    // Reply was pending — counts already set, log the no-op
    await countManager.onStatusChanged(tx, 'reply', newCaw.id, 'PENDING', 'SUCCESS', {
      cawId: parentCawId, replyCawId: newCaw.id,
    })
  }
}

/**
 * Handle RECAW action - create recaw and update counts
 */
export async function handleRecawAction(
  tx: PrismaTransactionClient,
  action: any,
  rawAction: any,
  parentCawId?: number
): Promise<void> {
  const userId = await findOrCreateUser(action.senderId)

  // Use the parentCawId that was already found in domainProcessor,
  // or look it up using the receiver's ID (not sender's)
  let originalCawId = parentCawId
  if (!originalCawId && rawAction.receiverCawonce != null && rawAction.receiverId != null) {
    originalCawId = await findCawId(rawAction.receiverCawonce, rawAction.receiverId)
  }

  if (!originalCawId) {
    throw new Error(`Cannot create recaw: original caw not found (receiverCawonce: ${rawAction.receiverCawonce}, receiverId: ${rawAction.receiverId})`)
  }

  // Check if recaw already exists to avoid double-counting
  const existingRecaw = await tx.caw.findUnique({
    where: {
      userId_cawonce: {
        userId: userId,
        cawonce: action.cawonce
      }
    }
  })

  // Use upsert to prevent duplicate RECAWs
  await tx.caw.upsert({
    where: {
      userId_cawonce: {
        userId: userId,
        cawonce: action.cawonce
      }
    },
    update: {
      // If RECAW already exists, update status to SUCCESS
      status: 'SUCCESS',
      updatedAt: new Date()
    },
    create: {
      originalCawId: originalCawId,
      userId: userId,
      action: action.actionType,
      cawonce: action.cawonce,
      content: rawAction.text
    }
  })

  // Increment counts only if this is truly new (no existing record).
  // If it was pending, counts were already optimistically incremented by the API.
  const wasPendingRecaw = existingRecaw?.status === 'PENDING'
  if (!existingRecaw) {
    // onCawCreated handles user.cawCount/recawCount and parent recawCount
    const isQuoteRecaw = rawAction.text && rawAction.text.trim().length > 0
    const recawCaw = await tx.caw.findUnique({ where: { userId_cawonce: { userId, cawonce: action.cawonce } } })
    await countManager.onCawCreated(tx, {
      id: recawCaw!.id,
      userId,
      action: isQuoteRecaw ? 'CAW' : 'RECAW',
      originalCawId,
      status: 'SUCCESS',
    })
    try {
      if (isQuoteRecaw) {
        const newCaw = await tx.caw.findUnique({ where: { userId_cawonce: { userId, cawonce: action.cawonce } } })
        if (newCaw) await NotificationService.createQuoteNotification(originalCawId, newCaw.id, userId, tx)
      } else {
        await NotificationService.createRepostNotification(originalCawId, userId)
      }
    } catch (err) {
      console.error(`Failed to create repost/quote notification:`, err)
    }
  } else if (wasPendingRecaw) {
    // Was pending — counts already set optimistically, log the no-op
    const recawCaw = await tx.caw.findUnique({ where: { userId_cawonce: { userId, cawonce: action.cawonce } } })
    if (recawCaw) {
      const isQuoteRecaw = rawAction.text && rawAction.text.trim().length > 0
      await countManager.onStatusChanged(tx, 'caw', recawCaw.id, 'PENDING', 'SUCCESS', {
        userId, action: isQuoteRecaw ? 'CAW' : 'RECAW', originalCawId,
      })
    }
  }
}

/**
 * Handle LIKE action - create or update like and update counts
 */
export async function handleLikeAction(
  tx: PrismaTransactionClient,
  action: any,
  rawAction: any,
  parentCawId?: number
): Promise<void> {
  const userId = await findOrCreateUser(action.senderId)

  // Get the caw being liked
  if (!parentCawId && rawAction.receiverId && rawAction.receiverCawonce) {
    // Try to find the caw from rawAction data
    parentCawId = await findCawId(rawAction.receiverCawonce, rawAction.receiverId)
  }

  if (!parentCawId) {
    throw new Error('Cannot like without a target caw')
  }

  // Check if the like already exists
  const existing = await tx.like.findUnique({
    where: { userId_cawId: { userId, cawId: parentCawId } }
  })

  if (existing) {
    if (existing.pending) {
      await tx.like.update({
        where: { userId_cawId: { userId, cawId: parentCawId } },
        data: { action: 'LIKE', pending: false }
      })
      // likeCount was already optimistically incremented — log the no-op
      await countManager.onStatusChanged(tx, 'like', existing.id, 'PENDING', 'SUCCESS', {
        cawId: parentCawId, userId,
      })

      // Create like notification for pending->confirmed transition
      try {
        await NotificationService.createLikeNotification(parentCawId, userId)
      } catch (err) {
        console.error(`Failed to create like notification for confirmed pending like:`, err)
      }
    } else {
      // Already processed, just ensure it's marked as LIKE
      await tx.like.update({
        where: { userId_cawId: { userId, cawId: parentCawId } },
        data: { action: 'LIKE', pending: false }
      })
    }
  } else {
    // Create the like and bump counts via CountManager
    await tx.like.create({
      data: { userId, cawId: parentCawId, action: 'LIKE', pending: false }
    })
    await countManager.onLikeCreated(tx, {
      cawId: parentCawId,
      userId,
      pending: false,
    })

    // Create like notification
    try {
      await NotificationService.createLikeNotification(parentCawId, userId)
    } catch (err) {
      console.error(`Failed to create like notification:`, err)
    }
  }
}

/**
 * Handle UNLIKE action - remove like and update counts
 */
export async function handleUnlikeAction(
  tx: PrismaTransactionClient,
  action: any,
  rawAction: any
): Promise<void> {
  const userId = await findOrCreateUser(action.senderId)
  const cawId = await findCawId(rawAction.receiverCawonce, rawAction.receiverId)

  // Check if the like exists and isn't pending before deleting
  const existing = await tx.like.findUnique({
    where: { userId_cawId: { userId, cawId } }
  })

  if (existing) {
    // Delete the like
    await tx.like.delete({
      where: { userId_cawId: { userId, cawId } }
    })

    // If it wasn't pending, decrement the count via CountManager
    if (!existing.pending) {
      await countManager.onLikeRemoved(tx, { cawId, userId })
    }
  }
}

/**
 * Handle FOLLOW action - create or update follow relationship
 * Updates follower counts:
 * - Increments followerId's followingCount (number of people they follow)
 * - Increments followingId's followerCount (number of followers they have)
 */
export async function handleFollowAction(
  tx: PrismaTransactionClient,
  action: any,
  rawAction: any
): Promise<void> {
  const followerId = await findOrCreateUser(action.senderId)
  const followingId = await findOrCreateUser(rawAction.receiverId)

  // Check if follow already exists
  const existingFollow = await tx.follow.findUnique({
    where: {
      followerId_followingId: {
        followerId,
        followingId
      }
    }
  })

  if (!existingFollow) {
    // Create new follow relationship or update pending to success
    await tx.follow.upsert({
      where: {
        followerId_followingId: {
          followerId,
          followingId
        }
      },
      update: {
        action: 'FOLLOW',
        status: 'SUCCESS'
      },
      create: {
        followerId,
        followingId,
        action: 'FOLLOW',
        status: 'SUCCESS'
      }
    })

    // Update counts via CountManager
    await countManager.onFollowCreated(tx, { followerId, followingId })

    console.log(`User ${followerId} now follows user ${followingId}`)

    // Create follow notification
    try {
      await NotificationService.createFollowNotification(followingId, followerId)
    } catch (err) {
      console.error(`Failed to create follow notification:`, err)
    }
  } else if (existingFollow.action !== 'FOLLOW' || existingFollow.status !== 'SUCCESS') {
    // Update existing relationship back to FOLLOW or mark pending as success
    const wasPending = existingFollow.status === 'PENDING'

    await tx.follow.update({
      where: {
        followerId_followingId: {
          followerId,
          followingId
        }
      },
      data: {
        action: 'FOLLOW',
        status: 'SUCCESS'
      }
    })

    // Increment counts if this was an unfollow being re-followed (not a pending confirmation)
    if (existingFollow.action !== 'FOLLOW') {
      // Re-follow after unfollow — increment counts
      await countManager.onFollowCreated(tx, { followerId, followingId })
    } else if (existingFollow.status === 'PENDING') {
      // Pending follow being confirmed — counts already set, log no-op
      await countManager.onStatusChanged(tx, 'follow', existingFollow.id, 'PENDING', 'SUCCESS', {
        followerId, followingId,
      })
    }

    console.log(`User ${followerId} re-followed user ${followingId}`)

    // Create follow notification if this was a pending follow being confirmed
    if (wasPending) {
      try {
        await NotificationService.createFollowNotification(followingId, followerId)
      } catch (err) {
        console.error(`Failed to create follow notification:`, err)
      }
    }
  }
}

/**
 * Handle UNFOLLOW action - remove follow relationship
 */
export async function handleUnfollowAction(
  tx: PrismaTransactionClient,
  action: any,
  rawAction: any
): Promise<void> {
  const followerId = await findOrCreateUser(action.senderId)
  const followingId = await findOrCreateUser(rawAction.receiverId)

  // Delete the follow relationship
  const deleted = await tx.follow.deleteMany({
    where: {
      followerId,
      followingId,
      action: 'FOLLOW' // Only delete if it's a FOLLOW relationship
    }
  })

  if (deleted.count > 0) {
    // Update counts via CountManager (uses safe decrement, never goes negative)
    await countManager.onFollowRemoved(tx, { followerId, followingId })

    console.log(`User ${followerId} unfollowed user ${followingId}`)
  } else {
    console.log(`User ${followerId} was not following user ${followingId}`)
  }
}

/**
 * Handle OTHER action - for image uploads, profile updates, and other custom content
 */
export async function handleOtherAction(
  tx: PrismaTransactionClient,
  action: any,
  rawAction: any,
  authorId: number,
  parentCawId?: number
): Promise<void> {
  // Check if this is a hide action (hide own post or undo recaw)
  if (rawAction.text?.startsWith('hide:')) {
    await handleHideAction(tx, action, rawAction, authorId)
    return
  }

  // Check if this is a tip action
  if (rawAction.text?.startsWith('tip:')) {
    await handleTipAction(tx, action, rawAction, authorId)
    return
  }

  // Check if this is a vote action (poll vote or unvote)
  if (rawAction.text?.startsWith('vote:')) {
    await handleVoteAction(tx, action, rawAction, authorId)
    return
  }

  // Check if this is a profile pin/unpin action.
  // pi:{cawId}  — pin
  // xpi:{cawId} — unpin
  // Order: xpi: first, since startsWith('pi:') doesn't match 'xpi:' but
  // grouping the two pin handlers together keeps the dispatch readable.
  if (rawAction.text?.startsWith('xpi:')) {
    await handleUnpinAction(tx, rawAction, authorId)
    return
  }
  if (rawAction.text?.startsWith('pi:')) {
    await handlePinAction(tx, rawAction, authorId)
    return
  }

  // Check if this is a profile update (both old and new formats)
  if (rawAction.text?.startsWith('profile-update:') || rawAction.text?.startsWith('p:')) {
    console.log('Processing profile update for user:', authorId)

    try {
      // Parse the JSON data after the prefix (support both formats)
      const jsonStr = rawAction.text.startsWith('p:')
        ? rawAction.text.replace('p:', '').trim()
        : rawAction.text.replace('profile-update:', '').trim()
      const profileData = JSON.parse(jsonStr)

      // Map compact keys to full field names
      const keyMap: Record<string, string> = {
        'n': 'displayName', // name/displayName
        'd': 'bio',        // description/bio
        'l': 'location',   // location
        'w': 'website',    // website
        'a': 'avatarUrl',  // avatar
        'c': 'coverPhotoUrl', // cover
        // Also support full field names for backward compatibility
        'bio': 'bio',
        'displayName': 'displayName',
        'location': 'location',
        'website': 'website',
        'avatarUrl': 'avatarUrl',
        'coverPhotoUrl': 'coverPhotoUrl'
      }

      const updateData: any = {}

      for (const [key, value] of Object.entries(profileData)) {
        const field = keyMap[key]
        if (!field) continue // Skip unknown fields

        if (value !== undefined) {
          // Sanitize string values
          if (typeof value === 'string') {
            const trimmedValue = value.trim()

            // Additional validation for specific fields
            if (field === 'website' && trimmedValue) {
              // Basic URL validation
              if (!trimmedValue.match(/^https?:\/\/.+/) && !trimmedValue.match(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)) {
                console.warn(`Invalid website URL for user ${authorId}: ${trimmedValue}`)
                continue
              }
            }

            if (field === 'bio' && trimmedValue.length > 500) {
              updateData[field] = trimmedValue.substring(0, 500)
            } else if (field === 'displayName' && trimmedValue.length > 50) {
              updateData[field] = trimmedValue.substring(0, 50)
            } else if (field === 'location' && trimmedValue.length > 100) {
              updateData[field] = trimmedValue.substring(0, 100)
            } else if (field === 'website' && trimmedValue.length > 200) {
              updateData[field] = trimmedValue.substring(0, 200)
            } else if ((field === 'avatarUrl' || field === 'coverPhotoUrl') && trimmedValue.length > 500) {
              updateData[field] = trimmedValue.substring(0, 500)
            } else {
              updateData[field] = trimmedValue
            }
          }
        }
      }

      // Update the user profile and clear the pending flag
      await tx.user.update({
        where: { tokenId: authorId },
        data: {
          ...updateData,
          profileUpdatePending: false,
          profileSource: 'onchain'
        }
      })

      console.log('Profile updated successfully for user:', authorId, updateData)
      return // Exit early for profile updates
    } catch (err) {
      console.error('Failed to process profile update:', err)
      // Continue to process as regular OTHER action if parsing fails
    }
  }

  // RECAW quotes (recaws with text) legitimately fall through here so we
  // can create the quote-Caw below. Plain OTHER actions whose text didn't
  // match any of the prefix handlers above (hide:, tip:, vote:, xpi:, pi:,
  // profile-update:, p:) are unrecognized and MUST NOT be turned into
  // Caw posts — that's how a `pi:<bad-cawId>` or any future-prefix action
  // ends up rendered as a feed post containing the raw protocol string.
  // Log loudly so we notice new prefixes that need handlers, then bail.
  if (action.actionType === 'OTHER') {
    const prefix = (rawAction.text || '').split(':', 1)[0]
    console.warn(
      `[ActionProcessor] Unrecognized OTHER action — no Caw created. ` +
      `senderId=${authorId} cawonce=${action.cawonce} prefix=${JSON.stringify(prefix)} ` +
      `text=${JSON.stringify((rawAction.text || '').slice(0, 80))}`,
    )
    return
  }

  let textContent = rawAction.text
  const imageData = null

  // Determine action type. Only RECAW reaches here as a non-OTHER
  // actionType (the OTHER guard above handles anything that didn't
  // match a known prefix). Quotes carry text, plain recaws don't —
  // both write a Caw row with action='RECAW'.
  const effectiveActionType = action.actionType === 'RECAW' ? 'RECAW'
    : (textContent || imageData) ? 'CAW' : action.actionType

  // Use upsert to prevent duplicate CAWs
  const newCaw = await tx.caw.upsert({
    where: {
      userId_cawonce: {
        userId: authorId,
        cawonce: action.cawonce
      }
    },
    update: {
      // If CAW already exists, just update the timestamps
      updatedAt: new Date()
    },
    create: {
      userId: authorId,
      cawonce: action.cawonce,
      content: textContent,
      action: effectiveActionType as any,
      originalCawId: parentCawId,
      imageData: imageData,
      hasImage: !!imageData
    }
  })

  // Process hashtags for the text content
  if (textContent) {
    try {
      await processHashtagsForCaw(newCaw.id, textContent, tx)
    } catch (err) {
      console.error(`Failed to process hashtags for caw ${newCaw.id}:`, err)
    }
  }

  // Index in Elasticsearch (non-blocking)
  setImmediate(async () => {
    const cawWithUser = await prisma.caw.findUnique({
      where: { id: newCaw.id },
      include: { user: true }
    })
    if (cawWithUser) {
      await elasticsearchService.indexCaw(cawWithUser)
    }
  })

  // Update counts via CountManager (same as regular caw).
  // For replies (parentCawId set), don't pass originalCawId — we don't want recawCount
  // bumped on the parent; commentCount is handled separately below.
  const otherOriginalCawId = (effectiveActionType === 'RECAW' && parentCawId) ? parentCawId : null
  await countManager.onCawCreated(tx, {
    id: newCaw.id,
    userId: authorId,
    action: effectiveActionType === 'RECAW' ? 'RECAW' : 'CAW',
    originalCawId: otherOriginalCawId,
    status: 'SUCCESS',
  })

  // If this was a comment/reply, bump the parent's comment count (once)
  if (parentCawId) {
    await countManager.onReplyCreated(tx, {
      cawId: parentCawId,
      replyCawId: newCaw.id,
      pending: false,
    })
  }
}
/**
 * Handle WITHDRAW action - create withdrawal request in database
 */
export async function handleWithdrawAction(
  tx: PrismaTransactionClient,
  action: any,
  rawAction: any
): Promise<void> {
  console.log('[handleWithdrawAction] Processing WITHDRAW action:', {
    senderId: action.senderId,
    cawonce: rawAction.cawonce,
    amounts: rawAction.amounts
  })

  // The first amount is the withdrawal amount in whole CAW units (not wei, due to uint64 limitation in action struct)
  const withdrawalAmount = rawAction.amounts?.[0]?.toString() || '0'

  // Create or update withdrawal request
  try {
    const existingRequest = await tx.withdrawalRequest.findFirst({
      where: {
        userId: action.senderId,
        cawonce: rawAction.cawonce
      }
    })

    if (existingRequest) {
      console.log('[handleWithdrawAction] Withdrawal request already exists:', existingRequest.id)
    } else {
      const withdrawalRequest = await tx.withdrawalRequest.create({
        data: {
          userId: action.senderId,
          amount: withdrawalAmount,
          cawonce: rawAction.cawonce,
          status: 'pending'
        }
      })
      console.log('[handleWithdrawAction] Created withdrawal request:', withdrawalRequest.id)
    }
  } catch (err) {
    console.error('[handleWithdrawAction] Error creating withdrawal request:', err)
    throw err
  }
}

/**
 * Handle TIP action - record a tip and create notification
 * Text format: "tip:userId:cawonce" (post tip) or "tip:" (profile tip)
 */
async function handleTipAction(
  tx: PrismaTransactionClient,
  action: any,
  rawAction: any,
  senderId: number
): Promise<void> {
  console.log('[handleTipAction] Processing tip action:', {
    senderId,
    text: rawAction.text,
    recipients: rawAction.recipients,
    amounts: rawAction.amounts
  })

  const recipientTokenId = Number(rawAction.recipients?.[0])
  const tipAmount = Number(rawAction.amounts?.[0])

  if (!recipientTokenId || !tipAmount) {
    console.error('[handleTipAction] Missing recipient or amount')
    return
  }

  const recipientId = await findOrCreateUser(recipientTokenId)

  // Parse target caw from text: "tip:userId:cawonce"
  //
  // SECURITY: only attribute the tip to a Caw if the on-chain recipient
  // (recipients[0]) matches the targetUserId in the text. Without this
  // check, anyone could post `text="tip:famousUser:0"` with
  // recipients=[ownAttackerToken], pay themselves 1 wei, and inflate
  // famousUser's per-caw `tipCount` / `totalTipped` counters. The
  // text-derived cawId is unauthenticated; only the (recipientId,
  // amount) pair on chain is. Audit fix 2026-05-09 (Round 6 cross-layer
  // agent CL-5).
  let cawId: number | null = null
  const parts = rawAction.text.replace('tip:', '').split(':')
  if (parts.length >= 2 && parts[0] && parts[1]) {
    const targetUserId = parseInt(parts[0])
    const targetCawonce = parseInt(parts[1])
    if (!isNaN(targetUserId) && !isNaN(targetCawonce) && targetUserId === recipientTokenId) {
      try {
        cawId = await findCawId(targetCawonce, targetUserId)
      } catch (err) {
        console.warn('[handleTipAction] Could not find target caw:', err)
      }
    } else if (!isNaN(targetUserId) && targetUserId !== recipientTokenId) {
      console.warn(
        `[handleTipAction] tip text targetUserId (${targetUserId}) !== recipients[0] (${recipientTokenId}); ` +
        `not attributing to any caw to prevent metadata forgery`
      )
    }
  }

  // Confirm pending tip or create new one (for actions from other validators)
  const existingTip = await tx.tip.findFirst({
    where: {
      senderId,
      recipientId,
      cawonce: action.cawonce,
      pending: true
    }
  })

  if (existingTip) {
    await tx.tip.update({
      where: { id: existingTip.id },
      data: { pending: false, cawId }
    })
    console.log('[handleTipAction] Confirmed pending tip:', existingTip.id)
  } else {
    await tx.tip.create({
      data: {
        senderId,
        recipientId,
        amount: Number(tipAmount),
        cawId,
        cawonce: action.cawonce,
        pending: false
      }
    })
    console.log('[handleTipAction] Created tip record:', {
      senderId,
      recipientId,
      amount: Number(tipAmount),
      cawId
    })
  }

  // Create notification
  try {
    await NotificationService.createTipNotification(recipientId, senderId, cawId || undefined, Number(tipAmount))
  } catch (err) {
    console.error('[handleTipAction] Failed to create tip notification:', err)
  }
}

/**
 * Handle vote actions on polls.
 *
 * Text formats:
 *   vote:N    — cast/change vote to option N (0-based index)
 *   vote:     — unvote (remove existing vote)
 *
 * The target poll is identified by (receiverId, receiverCawonce):
 *   receiverId = the poll author's tokenId
 *   receiverCawonce = the cawonce of the caw the poll lives on
 *
 * We use the EIP-712 canonical pointers (NOT recipients[]) because:
 *   1. recipients[] must match the contract's amounts/recipients invariant
 *      for value distribution — votes don't move CAW between users, so
 *      recipients[] is empty and only carries the validator tip.
 *   2. receiverId/receiverCawonce are the same fields replies/likes/recaws
 *      already use to address a target caw. Mirror nodes agree on these
 *      regardless of local DB state.
 *
 * Vote semantics: one row per (pollId, voterId). Voting again UPDATEs the
 * existing row's optionIndex; unvoting DELETEs the row. Poll.totalVotes is
 * incremented/decremented atomically alongside.
 *
 * Confirms a pending vote (set pending=false) when the API submit path
 * already wrote one optimistically — same pattern as Like / Tip.
 */
async function handleVoteAction(
  tx: PrismaTransactionClient,
  action: any,
  rawAction: any,
  voterId: number,
): Promise<void> {
  const parsed = parseVoteText(rawAction.text)
  if (!parsed) {
    console.warn('[handleVoteAction] Unrecognized vote text:', rawAction.text)
    return
  }

  const pollOwnerTokenId = Number(rawAction.receiverId)
  const targetCawonce = Number(rawAction.receiverCawonce)
  if (!pollOwnerTokenId || !Number.isFinite(targetCawonce)) {
    console.warn('[handleVoteAction] Missing receiverId/cawonce for vote:', { rawAction })
    return
  }

  // Resolve the local userId for the poll's author. findOrCreateUser is
  // idempotent + cached; safe to call inside a tx (it doesn't open another).
  const ownerUserId = await findOrCreateUser(pollOwnerTokenId)

  // Resolve the Caw row by its (userId, cawonce) — both pieces come from
  // the on-chain action data. If the caw isn't indexed yet (we received the
  // vote before the parent caw's CAW event), we can't index this vote yet
  // either. The cleanest behavior: skip silently and let the next poll
  // pick it up when the caw lands. RawEventsGatherer processes events in
  // chain order so this race is rare but possible across mirror nodes.
  const targetCaw = await tx.caw.findUnique({
    where: { userId_cawonce: { userId: ownerUserId, cawonce: targetCawonce } },
    select: { id: true, poll: { select: { id: true, totalVotes: true } } },
  })
  if (!targetCaw) {
    console.warn(`[handleVoteAction] Target caw not found yet (owner=${ownerUserId} cawonce=${targetCawonce}) — skipping`)
    return
  }
  if (!targetCaw.poll) {
    console.warn(`[handleVoteAction] Target caw ${targetCaw.id} has no poll — vote ignored`)
    return
  }

  // Unvote path
  if (parsed.optionIndex === null) {
    const existing = await tx.vote.findUnique({
      where: { pollId_voterId: { pollId: targetCaw.poll.id, voterId } },
    })
    if (!existing) {
      console.log(`[handleVoteAction] Unvote with no existing vote (poll=${targetCaw.poll.id} voter=${voterId}) — no-op`)
      return
    }
    await tx.vote.delete({ where: { id: existing.id } })
    if (!existing.pending) {
      // Only decrement when we're removing a confirmed vote — pending votes
      // never bumped totalVotes (the count is for confirmed only).
      await tx.poll.update({
        where: { id: targetCaw.poll.id },
        data: { totalVotes: { decrement: 1 } },
      })
    }
    console.log(`[handleVoteAction] Removed vote (poll=${targetCaw.poll.id} voter=${voterId})`)
    return
  }

  // Vote / change-vote path. Bounds check against the actual options
  // count, not POLL_MAX_OPTIONS — a poll might have only 3 options and a
  // stale frontend that submitted optionIndex=4 should be rejected.
  const optionsCount = await tx.poll.findUnique({
    where: { id: targetCaw.poll.id },
    select: { options: true },
  })
  if (!optionsCount || parsed.optionIndex >= optionsCount.options.length) {
    console.warn(`[handleVoteAction] optionIndex ${parsed.optionIndex} out of range for poll ${targetCaw.poll.id}`)
    return
  }

  // Upsert the vote row. There's an existing pending row when the API
  // submitted optimistically — flip pending → false and update the index.
  // If no existing row, this is a vote from a remote node and we create
  // it confirmed in one shot.
  const existing = await tx.vote.findUnique({
    where: { pollId_voterId: { pollId: targetCaw.poll.id, voterId } },
  })

  if (existing) {
    const wasPending = existing.pending
    const indexChanged = existing.optionIndex !== parsed.optionIndex
    await tx.vote.update({
      where: { id: existing.id },
      data: {
        optionIndex: parsed.optionIndex,
        cawonce: action.cawonce,
        pending: false,
      },
    })
    // Only bump totalVotes when a pending row gets CONFIRMED (it wasn't
    // counted before). Changing the option on an already-confirmed vote
    // is a no-op for totalVotes.
    if (wasPending) {
      await tx.poll.update({
        where: { id: targetCaw.poll.id },
        data: { totalVotes: { increment: 1 } },
      })
    }
    console.log(`[handleVoteAction] ${wasPending ? 'Confirmed' : indexChanged ? 'Updated' : 'Re-confirmed'} vote (poll=${targetCaw.poll.id} voter=${voterId} option=${parsed.optionIndex})`)
  } else {
    await tx.vote.create({
      data: {
        pollId: targetCaw.poll.id,
        voterId,
        optionIndex: parsed.optionIndex,
        cawonce: action.cawonce,
        pending: false,
      },
    })
    await tx.poll.update({
      where: { id: targetCaw.poll.id },
      data: { totalVotes: { increment: 1 } },
    })
    console.log(`[handleVoteAction] Created vote (poll=${targetCaw.poll.id} voter=${voterId} option=${parsed.optionIndex})`)
  }
}

/**
 * Handle hide actions — user hiding their own post or undoing a recaw.
 *
 * Text formats:
 *   hide:caw:{cawonce}                        — hide own post
 *   hide:recaw:{receiverId}:{receiverCawonce}  — undo own recaw
 */
async function handleHideAction(
  tx: PrismaTransactionClient,
  action: any,
  rawAction: any,
  senderId: number
): Promise<void> {
  const text: string = rawAction.text || ''
  console.log('[handleHideAction] Processing:', { senderId, text })

  if (text.startsWith('hide:caw:')) {
    // Hide own post: hide:caw:{cawonce}
    const cawonce = parseInt(text.replace('hide:caw:', ''))
    if (isNaN(cawonce)) {
      console.error('[handleHideAction] Invalid cawonce:', text)
      return
    }

    // Read imageData BEFORE flipping status so we know which URLs were
    // attached to the post. These get queued for delayed deletion (7-day
    // grace, see orphanedMedia.ts) so revertable hides don't lose data.
    const target = await tx.caw.findFirst({
      where:  { userId: senderId, cawonce, status: 'SUCCESS' },
      select: { imageData: true },
    })

    const result = await tx.caw.updateMany({
      where: { userId: senderId, cawonce, status: 'SUCCESS' },
      data: { status: 'HIDDEN' }
    })

    if (result.count > 0) {
      console.log(`[handleHideAction] Hidden caw: user=${senderId} cawonce=${cawonce}`)
      // Best-effort, fire-and-forget — Redis errors don't fail the hide.
      markOrphansInImageData(target?.imageData).catch(e =>
        console.warn('[handleHideAction] markOrphansInImageData failed:', e)
      )
    } else {
      console.warn(`[handleHideAction] No matching caw found: user=${senderId} cawonce=${cawonce}`)
    }
  } else if (text.startsWith('hide:recaw:')) {
    // Undo recaw: hide:recaw:{receiverId}:{receiverCawonce}
    const parts = text.replace('hide:recaw:', '').split(':')
    const receiverId = parseInt(parts[0])
    const receiverCawonce = parseInt(parts[1])
    if (isNaN(receiverId) || isNaN(receiverCawonce)) {
      console.error('[handleHideAction] Invalid recaw target:', text)
      return
    }

    // Find the original caw being recawed
    const originalCaw = await tx.caw.findFirst({
      where: { userId: receiverId, cawonce: receiverCawonce },
      select: { id: true }
    })
    if (!originalCaw) {
      console.warn(`[handleHideAction] Original caw not found: user=${receiverId} cawonce=${receiverCawonce}`)
      return
    }

    // Delete the sender's recaw of that post
    const deleted = await tx.caw.deleteMany({
      where: { userId: senderId, originalCawId: originalCaw.id, action: 'RECAW' }
    })

    if (deleted.count > 0) {
      // Decrement the parent's recawCount
      await tx.caw.update({
        where: { id: originalCaw.id },
        data: { recawCount: { decrement: deleted.count } }
      })
      console.log(`[handleHideAction] Deleted recaw: user=${senderId} of caw=${originalCaw.id}`)
    } else {
      console.warn(`[handleHideAction] No recaw found to delete: user=${senderId} originalCaw=${originalCaw.id}`)
    }
  } else {
    console.warn('[handleHideAction] Unknown hide format:', text)
  }
}

/**
 * Handle profile pin actions: confirm a previously-optimistic PinnedCaw
 * row, or upsert one fresh if the indexer ran before /api/actions did
 * (mirror nodes pulling chain history from another instance see no
 * optimistic write).
 *
 * Text format: pi:{cawId} — pin that caw to the sender's profile.
 *
 * Cap: NOT enforced here. Up to 3 most-recent pins surface on read —
 * older confirmed pins are harmless tombstones until the user unpins
 * one of the visible 3.
 *
 * Authorization: the cawId must belong to `senderId`. Anyone can submit
 * an OTHER action with arbitrary text; silently ignoring foreign-owned
 * targets prevents User A from pinning User B's post via the indexer.
 */
async function handlePinAction(
  tx: PrismaTransactionClient,
  rawAction: any,
  senderId: number
): Promise<void> {
  const text: string = rawAction.text || ''
  const cawId = parseInt(text.replace('pi:', '').trim())
  if (isNaN(cawId) || cawId <= 0) {
    console.warn('[handlePinAction] Invalid cawId:', text)
    return
  }

  const target = await tx.caw.findUnique({
    where: { id: cawId },
    select: { userId: true },
  })
  if (!target) {
    console.warn(`[handlePinAction] Caw not found: id=${cawId}`)
    return
  }
  if (target.userId !== senderId) {
    console.warn(`[handlePinAction] User ${senderId} cannot pin caw ${cawId} owned by ${target.userId}`)
    return
  }

  // Two cases the indexer needs to handle:
  //   (a) /api/actions already wrote a pending row → flip pending=false.
  //   (b) Mirror node sees the on-chain event without an optimistic
  //       write → upsert the row directly with pending=false.
  // Both end at the same row state. We track whether pinnedCawCount
  // should be incremented: only when the row transitions from
  // (absent | pending) to (present, pending=false).
  const existing = await tx.pinnedCaw.findUnique({
    where: { userId_cawId: { userId: senderId, cawId } },
    select: { id: true, pending: true },
  })

  if (!existing) {
    await tx.pinnedCaw.create({
      data: { userId: senderId, cawId, pending: false },
    })
    await tx.user.update({
      where: { tokenId: senderId },
      data: { pinnedCawCount: { increment: 1 } },
    })
    console.log(`[handlePinAction] Created+confirmed pin caw=${cawId} for user=${senderId}`)
    return
  }

  if (existing.pending) {
    await tx.pinnedCaw.update({
      where: { id: existing.id },
      data: { pending: false },
    })
    await tx.user.update({
      where: { tokenId: senderId },
      data: { pinnedCawCount: { increment: 1 } },
    })
    console.log(`[handlePinAction] Confirmed pin caw=${cawId} for user=${senderId}`)
    return
  }

  // Already confirmed — idempotent no-op (e.g. duplicate event replay).
  console.log(`[handlePinAction] Pin caw=${cawId} for user=${senderId} already confirmed; skipping`)
}

/**
 * Handle profile unpin actions.
 *
 * Text format: xpi:{cawId} — unpin that caw from the sender's profile.
 *
 * Mirrors handlePinAction's two cases:
 *   (a) /api/actions already flipped the row's pending=true → delete it.
 *   (b) Mirror node sees the chain event with no optimistic write → also
 *       delete (idempotent if no row exists).
 *
 * Authorization isn't strictly required here because the row is keyed
 * by senderId — a foreign sender can only delete their own rows by
 * (userId, cawId) anyway.
 */
async function handleUnpinAction(
  tx: PrismaTransactionClient,
  rawAction: any,
  senderId: number
): Promise<void> {
  const text: string = rawAction.text || ''
  const cawId = parseInt(text.replace('xpi:', '').trim())
  if (isNaN(cawId) || cawId <= 0) {
    console.warn('[handleUnpinAction] Invalid cawId:', text)
    return
  }

  const existing = await tx.pinnedCaw.findUnique({
    where: { userId_cawId: { userId: senderId, cawId } },
    select: { id: true, pending: true },
  })
  if (!existing) {
    console.log(`[handleUnpinAction] No pin row for user=${senderId} caw=${cawId}; nothing to delete`)
    return
  }

  await tx.pinnedCaw.delete({ where: { id: existing.id } })
  // Only decrement if the row was confirmed: pending rows weren't
  // counted (count tracks confirmed pins).
  if (!existing.pending) {
    await tx.user.update({
      where: { tokenId: senderId },
      data: { pinnedCawCount: { decrement: 1 } },
    })
  }
  console.log(`[handleUnpinAction] Unpinned caw=${cawId} for user=${senderId} (was pending=${existing.pending})`)
}

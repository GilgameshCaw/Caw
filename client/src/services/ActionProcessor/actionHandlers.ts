// src/services/ActionProcessor/actionHandlers.ts
import { prisma } from '../../prismaClient'
import { findOrCreateUser } from '../UserService'
import { processHashtagsForCaw } from '../../tools/hashtags'
import { NotificationService } from '../NotificationService'
import { elasticsearchService } from '../ElasticsearchService'
import { countManager } from '../CountManager'
import type { PrismaTransactionClient } from './types'

/**
 * Helper function to find a caw by cawonce and user
 */
export async function findCawId(cawonce: number, userOnChain: number): Promise<number> {
  const uid = await findOrCreateUser(userOnChain)
  const c = await prisma.caw.findFirst({
    where: { userId: uid, action: 'CAW', cawonce: cawonce },
    orderBy: { createdAt: 'asc' }
  })
  if (!c) throw new Error(`target caw not found ${uid} cawonce: ${cawonce}`)
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
  // Extract image and video URLs from text if present
  // Match URLs like http://localhost:4000/uploads/... or any domain with /uploads/
  const imageUrlRegex = /(https?:\/\/[^\s]+\/uploads\/images\/[^\s]+\.(jpg|jpeg|png|gif|webp))/gi
  const imageUrls = rawAction.text?.match(imageUrlRegex) || []

  // Extract video URLs (prefixed with 'video:')
  const videoUrlRegex = /video:(https?:\/\/[^\s]+\/uploads\/videos\/[^\s]+\.(mp4|webm|mov|avi|mkv|ogg|ogv))/gi
  const videoMatches = [...(rawAction.text?.matchAll(videoUrlRegex) || [])]
  const videoUrls = videoMatches.map((match: RegExpMatchArray) => match[1]) // Extract just the URL without 'video:' prefix

  // Debug logging
  if (videoMatches.length > 0) {
    console.log('Found video URLs in text:', videoUrls)
  }

  // Remove image and video URLs from the text content for cleaner display
  let textContent = rawAction.text
  if (imageUrls.length > 0) {
    imageUrls.forEach((url: string) => {
      textContent = textContent.replace(url, '').trim()
    })
  }
  if (videoUrls.length > 0) {
    videoMatches.forEach((match: RegExpMatchArray) => {
      textContent = textContent.replace(match[0], '').trim() // Remove the full 'video:URL' string
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

  // Use upsert to prevent duplicate CAWs
  const newCaw = await tx.caw.upsert({
    where: {
      userId_cawonce: {
        userId: authorId,
        cawonce: action.cawonce
      }
    },
    update: {
      // If CAW already exists (was pending), update it to SUCCESS
      content: textContent,
      action: action.actionType,
      originalCawId: parentCawId,
      imageData: imageUrls.length > 0 ? `urls:${imageUrls.join('|||')}` : null,
      hasImage: imageUrls.length > 0,
      videoData: videoUrls.length > 0 ? videoUrls.join('|||') : null,
      hasVideo: videoUrls.length > 0,
      status: 'SUCCESS', // Mark as SUCCESS when confirmed on-chain
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
    console.log(`[handleCawAction] Processing hashtags for caw ${newCaw.id}, textContent: "${textContent}"`)
    await processHashtagsForCaw(newCaw.id, textContent, tx)
    console.log(`[handleCawAction] Finished processing hashtags for caw ${newCaw.id}`)
  } catch (err) {
    console.error(`Failed to process hashtags for caw ${newCaw.id}:`, err)
    // Don't fail the entire transaction if hashtag processing fails
  }

  // Create notifications for @mentions
  try {
    await NotificationService.createMentionNotifications(newCaw.id, textContent, authorId)
  } catch (err) {
    console.error(`Failed to create mention notifications for caw ${newCaw.id}:`, err)
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
        await NotificationService.createReplyNotification(parentCawId, newCaw.id, authorId)
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
        await NotificationService.createReplyNotification(parentCawId, newCaw.id, authorId)
      } catch (err) {
        console.error(`Failed to create reply notification for caw ${newCaw.id}:`, err)
      }
    } else {
      // It's a quote (RECAW with parent) — recawCount on parent is handled by onCawCreated below
      try {
        await NotificationService.createQuoteNotification(parentCawId, newCaw.id, authorId)
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
        if (newCaw) await NotificationService.createQuoteNotification(originalCawId, newCaw.id, userId)
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

  console.log("Create like: ", existing, "parentCawId:", parentCawId, "userId:", userId)

  if (existing) {
    // Update the action field and clear pending status
    // If it was pending, we need to increment the counter
    console.log("[handleLikeAction] Existing like found, pending:", existing.pending)
    if (existing.pending) {
      console.log("[handleLikeAction] Confirming pending like, will create notification")
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
        console.log("[handleLikeAction] Creating like notification for caw", parentCawId, "from user", userId)
        await NotificationService.createLikeNotification(parentCawId, userId)
        console.log("[handleLikeAction] Like notification created successfully")
      } catch (err) {
        console.error(`Failed to create like notification for confirmed pending like:`, err)
      }
    } else {
      console.log("[handleLikeAction] Like already confirmed, skipping notification")
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

  console.log(`[ActionProcessor] handleFollowAction: ${followerId} -> ${followingId}`)

  // Check if follow already exists
  const existingFollow = await tx.follow.findUnique({
    where: {
      followerId_followingId: {
        followerId,
        followingId
      }
    }
  })

  console.log(`[ActionProcessor] existingFollow:`, existingFollow ? `action=${existingFollow.action} status=${existingFollow.status}` : 'null')

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
  // Check if this is a tip action
  if (rawAction.text?.startsWith('tip:')) {
    await handleTipAction(tx, action, rawAction, authorId)
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

  let textContent = rawAction.text
  const imageData = null

  // Determine action type: preserve RECAW for quotes (recaws with text),
  // otherwise treat content/images as CAW posts.
  // (profile updates return early above, so we only get here for actual posts)
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
  let cawId: number | null = null
  const parts = rawAction.text.replace('tip:', '').split(':')
  if (parts.length >= 2 && parts[0] && parts[1]) {
    const targetUserId = parseInt(parts[0])
    const targetCawonce = parseInt(parts[1])
    if (!isNaN(targetUserId) && !isNaN(targetCawonce)) {
      try {
        cawId = await findCawId(targetCawonce, targetUserId)
      } catch (err) {
        console.warn('[handleTipAction] Could not find target caw:', err)
      }
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

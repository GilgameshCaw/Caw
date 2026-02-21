// src/services/ActionProcessor/actionHandlers.ts
import { prisma } from '../../prismaClient'
import { findOrCreateUser } from '../UserService'
import { processHashtagsForCaw } from '../../tools/hashtags'
import { NotificationService } from '../NotificationService'
import { elasticsearchService } from '../ElasticsearchService'
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
    await processHashtagsForCaw(newCaw.id, textContent)
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

  // Create notification if this is a reply
  if (parentCawId) {
    try {
      await NotificationService.createReplyNotification(parentCawId, newCaw.id, authorId)
    } catch (err) {
      console.error(`Failed to create reply notification for caw ${newCaw.id}:`, err)
    }
  }

  // Update comment count for original caw if this is a comment
  if (rawAction.originalCawId) {
    await tx.caw.update({
      where: { id: rawAction.originalCawId },
      data: { commentCount: { increment: 1 } }
    })
  }

  // Increment user's caw count
  await tx.user.update({
    where: { tokenId: rawAction.senderId },
    data: { cawCount: { increment: 1 } }
  })

  // If this was a comment, bump the parent's comment count
  if (parentCawId) {
    await tx.caw.update({
      where: { id: parentCawId },
      data: { commentCount: { increment: 1 } }
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

  // Use upsert to prevent duplicate RECAWs
  await tx.caw.upsert({
    where: {
      userId_cawonce: {
        userId: userId,
        cawonce: action.cawonce
      }
    },
    update: {
      // If RECAW already exists, just update the timestamps
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

  // Update recaw count on the original post
  await tx.caw.update({
    where: { id: originalCawId },
    data: { recawCount: { increment: 1 } }
  })

  // Create repost notification
  try {
    await NotificationService.createRepostNotification(originalCawId, userId)
  } catch (err) {
    console.error(`Failed to create repost notification:`, err)
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

  console.log("Create like: ", existing)

  if (existing) {
    // Update the action field and clear pending status
    // If it was pending, we need to increment the counter
    if (existing.pending) {
      await tx.like.update({
        where: { userId_cawId: { userId, cawId: parentCawId } },
        data: { action: 'LIKE', pending: false }
      })
      // Increment the like count since this is a pending->confirmed transition
      await tx.caw.update({
        where: { id: parentCawId },
        data: { likeCount: { increment: 1 } }
      })
    } else {
      // Already processed, just ensure it's marked as LIKE
      await tx.like.update({
        where: { userId_cawId: { userId, cawId: parentCawId } },
        data: { action: 'LIKE', pending: false }
      })
    }
  } else {
    // Create the like and bump the Caw.likeCount
    await tx.like.create({
      data: { userId, cawId: parentCawId, action: 'LIKE', pending: false }
    })
    await tx.caw.update({
      where: { id: parentCawId },
      data: { likeCount: { increment: 1 } }
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

    // If it wasn't pending, decrement the count
    if (!existing.pending) {
      await tx.caw.update({
        where: { id: cawId },
        data: { likeCount: { decrement: 1 } }
      })
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

    // Update counts: increment follower's followingCount and following's followerCount
    await tx.user.update({
      where: { tokenId: followerId },
      data: { followingCount: { increment: 1 } }
    })
    await tx.user.update({
      where: { tokenId: followingId },
      data: { followerCount: { increment: 1 } }
    })

    console.log(`User ${followerId} now follows user ${followingId}`)

    // Create follow notification
    try {
      await NotificationService.createFollowNotification(followingId, followerId)
    } catch (err) {
      console.error(`Failed to create follow notification:`, err)
    }
  } else if (existingFollow.action !== 'FOLLOW' || existingFollow.status !== 'SUCCESS') {
    // Update existing relationship back to FOLLOW or mark pending as success
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

    // Only increment counts if this was not already a successful follow
    if (existingFollow.action !== 'FOLLOW') {
      // Update counts: increment follower's followingCount and following's followerCount
      await tx.user.update({
        where: { tokenId: followerId },
        data: { followingCount: { increment: 1 } }
      })
      await tx.user.update({
        where: { tokenId: followingId },
        data: { followerCount: { increment: 1 } }
      })
    }

    console.log(`User ${followerId} re-followed user ${followingId}`)
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
    // Update counts: decrement follower's followingCount and following's followerCount
    await tx.user.update({
      where: { tokenId: followerId },
      data: { followingCount: { decrement: 1 } }
    })
    await tx.user.update({
      where: { tokenId: followingId },
      data: { followerCount: { decrement: 1 } }
    })

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
          profileUpdatePending: false
        }
      })

      console.log('Profile updated successfully for user:', authorId, updateData)
      return // Exit early for profile updates
    } catch (err) {
      console.error('Failed to process profile update:', err)
      // Continue to process as regular OTHER action if parsing fails
    }
  }

  // Extract image data if present (can be multiple images)
  let imageDataArray: string[] = []
  let textContent = rawAction.text

  if (rawAction.text?.includes('image64:')) {
    const lines = rawAction.text.split('\n')
    const imageLines: string[] = []
    const textLines: string[] = []

    let foundImages = false
    for (const line of lines) {
      if (line.startsWith('image64:')) {
        imageLines.push(line.replace('image64:', ''))
        foundImages = true
      } else if (foundImages && line === '') {
        // Empty line after images, rest is text content
        continue
      } else {
        textLines.push(line)
      }
    }

    imageDataArray = imageLines
    textContent = textLines.join('\n').trim()
  }

  // Join all images with a delimiter for storage
  const imageData = imageDataArray.length > 0 ? imageDataArray.join('|||') : null

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
      action: action.actionType,
      originalCawId: parentCawId,
      imageData: imageData, // Store base64 image data (multiple images separated by |||)
      hasImage: !!imageData
    }
  })

  // Process hashtags for the text content
  if (textContent) {
    try {
      await processHashtagsForCaw(newCaw.id, textContent)
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

  // Schedule background job to process image if needed
  if (imageData) {
    // TODO: Add image processing job to queue
    console.log(`Scheduling image processing for caw ${newCaw.id}`)
  }

  // Update counts same as regular caw
  if (rawAction.originalCawId) {
    await tx.caw.update({
      where: { id: rawAction.originalCawId },
      data: { commentCount: { increment: 1 } }
    })
  }

  await tx.user.update({
    where: { id: rawAction.senderId },
    data: { cawCount: { increment: 1 } }
  })

  if (parentCawId) {
    await tx.caw.update({
      where: { id: parentCawId },
      data: { commentCount: { increment: 1 } }
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

  // The first amount is the withdrawal amount in wei
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

// src/services/ActionProcessor/actionHandlers.ts
import { prisma } from '../../prismaClient'
import { findOrCreateUser } from '../UserService'
import { processHashtagsForCaw } from '../../tools/hashtags'
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
      // If CAW already exists, just update the timestamps
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
      hasVideo: videoUrls.length > 0
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

  // Update comment count for original caw if this is a comment
  if (rawAction.originalCawId) {
    await tx.caw.update({
      where: { id: rawAction.originalCawId },
      data: { commentCount: { increment: 1 } }
    })
  }

  // Increment user's caw count
  await tx.user.update({
    where: { id: rawAction.senderId },
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
  const originalCawId = await findCawId(rawAction.receiverCawonce, action.senderId)

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

  if (parentCawId) {
    await tx.caw.update({
      where: { id: parentCawId },
      data: { recawCount: { increment: 1 } }
    })
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
    // Just update the action field and clear pending status (no counter bump)
    await tx.like.update({
      where: { userId_cawId: { userId, cawId: parentCawId } },
      data: { action: 'LIKE', pending: false }
    })
  } else {
    // Create the like and bump the Caw.likeCount
    await tx.like.create({
      data: { userId, cawId: parentCawId, action: 'LIKE', pending: false }
    })
    await tx.caw.update({
      where: { id: parentCawId },
      data: { likeCount: { increment: 1 } }
    })
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
  await tx.like.deleteMany({
    where: {
      userId: await findOrCreateUser(action.senderId),
      cawId: await findCawId(rawAction.receiverCawonce, rawAction.senderId)
    }
  })
}

/**
 * Handle FOLLOW action - create or update follow relationship
 */
export async function handleFollowAction(
  tx: PrismaTransactionClient,
  action: any,
  rawAction: any
): Promise<void> {
  await tx.follow.upsert({
    where: {
      followerId_followingId: {
        followerId: await findOrCreateUser(action.senderId),
        followingId: await findOrCreateUser(rawAction.receiverId)
      }
    },
    update: { action: 'FOLLOW' },
    create: {
      followerId: await findOrCreateUser(action.senderId),
      followingId: await findOrCreateUser(rawAction.receiverId),
      action: 'FOLLOW'
    }
  })
}

/**
 * Handle UNFOLLOW action - remove follow relationship
 */
export async function handleUnfollowAction(
  tx: PrismaTransactionClient,
  action: any,
  rawAction: any
): Promise<void> {
  await tx.follow.deleteMany({
    where: {
      followerId: await findOrCreateUser(action.senderId),
      followingId: await findOrCreateUser(rawAction.receiverId)
    }
  })
}

/**
 * Handle OTHER action - for image uploads and other custom content
 */
export async function handleOtherAction(
  tx: PrismaTransactionClient,
  action: any,
  rawAction: any,
  authorId: number,
  parentCawId?: number
): Promise<void> {
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
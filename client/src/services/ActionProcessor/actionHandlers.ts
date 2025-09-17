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
 */
export async function handleCawAction(
  tx: PrismaTransactionClient,
  action: any,
  rawAction: any,
  authorId: number,
  parentCawId?: number
): Promise<void> {
  const newCaw = await tx.caw.create({
    data: {
      userId: authorId,
      cawonce: action.cawonce,
      content: rawAction.text,
      action: action.actionType,
      originalCawId: parentCawId,
    }
  })

  // Process hashtags for the new caw
  try {
    await processHashtagsForCaw(newCaw.id, rawAction.text)
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
  await tx.caw.create({
    data: {
      originalCawId: await findCawId(rawAction.receiverCawonce, action.senderId),
      userId: await findOrCreateUser(action.senderId),
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
  parentCawId?: number
): Promise<void> {
  const userId = await findOrCreateUser(action.senderId)

  if (!parentCawId) {
    throw new Error('Cannot like without a target caw')
  }

  // Check if the like already exists
  const existing = await tx.like.findUnique({
    where: { userId_cawId: { userId, cawId: parentCawId } }
  })

  console.log("Create like: ", existing)

  if (existing) {
    // Just update the action field (no counter bump)
    await tx.like.update({
      where: { userId_cawId: { userId, cawId: parentCawId } },
      data: { action: 'LIKE' }
    })
  } else {
    // Create the like and bump the Caw.likeCount
    await tx.like.create({
      data: { userId, cawId: parentCawId, action: 'LIKE' }
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
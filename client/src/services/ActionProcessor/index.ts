//src/services/ActionProcessor/index.ts
import { ActionType as PrismaActionType } from '@prisma/client'
import getActionType from '../../abi/getActionType'
import { findOrCreateUser } from '../UserService'
import { prisma } from '../../prismaClient'
import { Service } from '../../Service'
import Redis from 'ioredis'
import { z } from 'zod'

const Config = z.object({
  redisUrl: z.string().optional().default('redis://127.0.0.1:6379'),
})

export const actionProcessorService: Service = {
  name: 'ActionProcessor',

  validateConfig(cfg) {
    const res = Config.safeParse(cfg)
    return res.success ? [] : res.error.errors.map(e => new Error(e.message))
  },

  start(_cfg) {
    const { redisUrl } = Config.parse(_cfg)
    const redis = new Redis(redisUrl)
    let stopRequested = false
    let lastId = 0


    const started = (async () => {
      await prisma.$connect()
      const backlog = await prisma.rawEvent.findMany({
        where: { id: { gt: lastId } },
        orderBy: { id: 'asc' }
      })
      for (const raw of backlog) {
        if (stopRequested) break
        await handleRawEvent(raw)
        lastId = raw.id
      }

      // now subscribe to the same "raws" channel your Gatherer is publishing
      await redis.subscribe('raws')
      redis.on('message', async (_channel, msg) => {
        console.log("ActionProcessor received new message")
        const rawEventId = Number(msg)
        // ignore duplicates or out‑of‑order
        if (rawEventId > lastId) {
          const raw = await prisma.rawEvent.findUnique({ where: { id: rawEventId } })
          if (raw && !stopRequested) {
            await handleRawEvent(raw)
            lastId = rawEventId
          }
        }
      })

    })()

    return {
      started,
      async stop() {
        stopRequested = true
        await prisma.$disconnect()
      },
      stats: async () => `actions: ${await prisma.action.count()}`
    }
  }
}



/**
 * handleRawEvent
 * @description process one rawEvent into actions and domain rows
 */
async function handleRawEvent(raw: { id: number, chainId: number, data: any }) {
  const list = Array.isArray(raw.data) ? raw.data : [raw.data];
  for (const rawAction of list) {
    if (!filterAction(rawAction)) continue;
    await handleRawAction(raw.id, raw.chainId, rawAction);
  }
}


async function handleRawAction(rawId: number, chainId: number, rawAction: any): Promise<void> {
  await prisma.$transaction(async (tx) => {

    let action
    try {
      console.log("Will create?")
      action = await prisma.action.create({
        data: {
          rawEventId: rawId,
          chainId:    chainId,
          senderId:   rawAction.senderId,
          cawonce:    rawAction.cawonce,
          actionType: getActionType(Number(rawAction.actionType)),
          data:       rawAction
        }
      })
    } catch (err: any) {
      console.log("error - ", err.code === 'P2002' ? "already exists" : "other issue:")
      if (err.code === 'P2002') return
      console.log('action.create error', err)
      return
    }

    action = await prisma.action.findFirstOrThrow({
      where: { rawEventId: rawId }
    })



    // now materialize domain effects
    console.log("TYPe", action.actionType)

    const authorId = await findOrCreateUser(action.senderId)

    // detect “comment” vs brand-new post
    let parentCawId: number | undefined
    let originalCawId: number | undefined
    if (rawAction.receiverId) { // this doesn't work for follows, but maybe fine and maybe make it so cawonce is not able to be 0
      console.log("Searching for original caw id.... ", rawAction.receiverCawonce, rawAction.receiverId)
      parentCawId = await findCawId(
        rawAction.receiverCawonce,
        rawAction.receiverId
      )
    }

    switch (action.actionType) {
      case 'CAW':
        await prisma.caw.create({
          data: {
            userId:  authorId,
            cawonce: action.cawonce,
            content: rawAction.text,
            action:  action.actionType,
            originalCawId: parentCawId,
          }
        })
        if (rawAction.originalCawId) {
          await prisma.caw.update({
            where: { id: rawAction.originalCawId },
            data:  { commentCount: { increment: 1 } }
          })
        }

        // increment user’s cawCount
        await prisma.user.update({
          where: { id: rawAction.senderId },
          data: { cawCount: { increment: 1 } }
        })

        if (parentCawId)  // if it was a comment, bump the parent’s commentCount
          await prisma.caw.update({
            where: { id: parentCawId },
            data:  { commentCount: { increment: 1 } }
          })
        break

      case 'RECAW':
        await prisma.caw.create({
          data: {
            originalCawId: await findCawId(rawAction.receiverCawonce, action.senderId),
            userId:        await findOrCreateUser(action.senderId),
            action:        action.actionType,
            cawonce:       action.cawonce,
            content:       rawAction.text
          }
        })
        await prisma.caw.update({
          where: { id: parentCawId },
          data:  { recawCount: { increment: 1 } }
        })
        break


      case 'LIKE':
        const userId = await findOrCreateUser(action.senderId)
        // 1) see if there's already a like

        const existing = await prisma.like.findUnique({
          where: { userId_cawId: { userId, cawId: parentCawId } }

        })


        console.log("Create like: ", existing)
        if (existing) {
          // 2a) just update the action field (no counter bump)
          await tx.like.update({
            where: { userId_cawId: { userId, cawId: parentCawId } },
            data:  { action: 'LIKE' }

          })
        } else {
          // 2b) create the like _and_ bump the Caw.likeCount
          await tx.like.create({
            data: { userId, cawId: parentCawId, action: 'LIKE' }
          })
          await tx.caw.update({
            where: { id: parentCawId },
            data:  { likeCount: { increment: 1 } }
          })
        }
        break


      case 'UNLIKE':
        await prisma.like.deleteMany({
          where: {
            userId: await findOrCreateUser(action.senderId),
            cawId:  await findCawId(rawAction.receiverCawonce, rawAction.senderId)
          }
        })
        break

      case 'FOLLOW':
        await prisma.follow.upsert({
          where: {
            followerId_followingId: {
              followerId:  await findOrCreateUser(action.senderId),
              followingId: await findOrCreateUser(rawAction.receiverId)
            }
          },
          update: { action: 'FOLLOW' },
          create: {
            followerId:  await findOrCreateUser(action.senderId),
            followingId: await findOrCreateUser(rawAction.receiverId),
            action:      'FOLLOW'
          }
        })
        break

      case 'UNFOLLOW':
        await prisma.follow.deleteMany({
          where: {
            followerId:  await findOrCreateUser(action.senderId),
            followingId: await findOrCreateUser(rawAction.receiverId)
          }
        })
        break

        // other action types (WITHDRAW, OTHER) can be handled here
    }
  })
}

// placeholder: map on-chain senderId → your User.id
async function findUserId(senderId: number): Promise<number> {
  const u = await prisma.user.upsert({
    where: { address: String(senderId) },
    update: {},
    create: { address: String(senderId) }
  })
  return u.id
}

// placeholder: find the Caw this action targets (by cawonce & user)
async function findCawId(cawonce: number, userOnChain: number): Promise<number> {
  const uid = await findOrCreateUser(userOnChain)
  const c = await prisma.caw.findFirst({
    where: { userId: uid, action: 'CAW', cawonce: cawonce },
    orderBy: { createdAt: 'asc' }
  })
  if (!c) throw new Error(`target caw not found ${uid} cawonce: ${cawonce}`)
  return c.id
}

// allow all actions for now
function filterAction(_a: any): boolean {
  return true
}

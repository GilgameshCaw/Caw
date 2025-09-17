//src/services/ActionProcessor/index.ts
import { ActionType as PrismaActionType } from '@prisma/client'
import { prisma } from '../../prismaClient'
import { Service } from '../../Service'
import Redis from 'ioredis'
import { z } from 'zod'
import { createOrFindAction, ensureActionExists } from './actionCreation'
import { processDomainEffects } from './domainProcessor'
import type { RawAction } from './types'

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


async function handleRawAction(rawId: number, chainId: number, rawAction: RawAction): Promise<void> {
  await prisma.$transaction(async (tx) => {
    try {
      // Create or find existing action, determine if domain processing is needed
      const { action, shouldProcessDomain } = await createOrFindAction(tx, rawId, chainId, rawAction)

      if (!shouldProcessDomain) {
        return // Domain objects already exist, nothing to do
      }

      // Ensure we have a valid action before processing
      const validAction = await ensureActionExists(tx, rawId, action)

      // Process domain effects based on action type
      await processDomainEffects(tx, validAction, rawAction)
    } catch (err) {
      console.error('Failed to handle raw action:', err)
      // Don't re-throw to avoid failing the entire transaction batch
    }
  })
}

// NOTE: Helper functions moved to separate modules:
// - findCawId moved to actionHandlers.ts
// - User creation handled by UserService
// - Domain object checks moved to domainObjectChecks.ts
// - Action creation moved to actionCreation.ts

// allow all actions for now
function filterAction(_a: any): boolean {
  return true
}

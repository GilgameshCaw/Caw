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
        try {
          await handleRawEvent(raw)
          lastId = raw.id
        } catch (err) {
          console.error(`[ActionProcessor] Failed to process backlog event ${raw.id}:`, err)
          // Continue processing other events
          lastId = raw.id
        }
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
            try {
              await handleRawEvent(raw)
              lastId = rawEventId
            } catch (err) {
              console.error(`[ActionProcessor] Failed to process event ${rawEventId}:`, err)
              // Continue processing other events
              lastId = rawEventId
            }
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
  try {
    await prisma.$transaction(async (tx) => {
      // Create or find existing action, determine if domain processing is needed
      const { action, shouldProcessDomain } = await createOrFindAction(tx, rawId, chainId, rawAction)

      if (!shouldProcessDomain) {
        return // Domain objects already exist, nothing to do
      }

      // Ensure we have a valid action before processing
      const validAction = await ensureActionExists(tx, rawId, action)

      // Process domain effects based on action type
      await processDomainEffects(tx, validAction, rawAction)
    })
  } catch (err: any) {
    // If we hit a race condition, retry once to process the action created by another process
    if (err.message?.includes('Action already exists (race condition)')) {
      console.log('[ActionProcessor] Race condition detected, retrying to process existing action...')
      try {
        await prisma.$transaction(async (tx) => {
          // This time we should find the existing action
          const { action, shouldProcessDomain } = await createOrFindAction(tx, rawId, chainId, rawAction)

          if (!shouldProcessDomain) {
            console.log('[ActionProcessor] Action and domain objects already exist after retry')
            return
          }

          const validAction = await ensureActionExists(tx, rawId, action)
          await processDomainEffects(tx, validAction, rawAction)
        })
        console.log('[ActionProcessor] Successfully processed action after race condition retry')
      } catch (retryErr) {
        console.error('[ActionProcessor] Failed to handle raw action after retry:', retryErr)
      }
    } else {
      console.error('[ActionProcessor] Failed to handle raw action:', err)
    }
    // Don't re-throw to avoid crashing the processor
  }
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

//src/services/ActionProcessor/index.ts
import { ActionType as PrismaActionType } from '@prisma/client'
import { prisma } from '../../prismaClient'
import { Service } from '../../Service'
import Redis from 'ioredis'
import { z } from 'zod'
import { createOrFindAction, ensureActionExists } from './actionCreation'
import { processDomainEffects } from './domainProcessor'
import type { RawAction } from './types'
import { StaleTokenError } from '../UserService'
import { CAW_ACTIONS_ADDRESS } from '../../abi/addresses'

const Config = z.object({
  redisUrl: z.string().optional().default('redis://127.0.0.1:6379'),
})

export const actionProcessorService: Service = {
  name: 'ActionProcessor',

  validateConfig(cfg) {
    const res = Config.safeParse(cfg)
    return res.success ? [] : res.error.errors.map(e => new Error(e.message))
  },

  start(_cfg, ctx) {
    const { redisUrl } = Config.parse(_cfg)
    const redis = new Redis(redisUrl)
    let stopRequested = false

    // ActionProcessor is event-driven (Redis pub/sub). We heartbeat on each
    // message processed AND via a periodic idle ping so the watchdog knows
    // we're still listening during quiet periods.
    ctx.declareLoop('listen', 2 * 60_000) // Any quiet period over 2 min is suspicious
    const idleHeartbeat = setInterval(() => {
      if (!stopRequested) ctx.heartbeat('listen')
    }, 30_000)

    const started = (async () => {
      await prisma.$connect()
      ctx.heartbeat('listen') // Mark alive after connect

      // Resume from last processed action's rawEventId instead of reprocessing everything on restart
      const lastAction = await prisma.action.findFirst({
        orderBy: { id: 'desc' },
        select: { rawEventId: true }
      })
      let lastId = lastAction?.rawEventId ?? 0
      console.log(`[ActionProcessor] Resuming from lastId=${lastId}`)

      // Page through the backlog in chunks so restart after a large gap doesn't
      // load everything into memory at once. At 1M raw events this would OOM.
      const BACKLOG_CHUNK = 1000
      while (!stopRequested) {
        const backlog = await prisma.rawEvent.findMany({
          where: {
            id: { gt: lastId },
            contractAddress: CAW_ACTIONS_ADDRESS
          },
          orderBy: { id: 'asc' },
          take: BACKLOG_CHUNK,
        })
        if (backlog.length === 0) break
        const startOfChunk = lastId
        for (const raw of backlog) {
          if (stopRequested) break
          try {
            await handleRawEvent(raw)
            lastId = raw.id
          } catch (err) {
            if (err instanceof StaleTokenError) {
              console.warn(`[ActionProcessor] Skipping stale event ${raw.id}: ${err.message}`)
              lastId = raw.id
            } else {
              console.error(`[ActionProcessor] Failed to process backlog event ${raw.id}:`, err)
              // Don't advance lastId — the next restart will retry this event.
            }
          }
          ctx.heartbeat('listen')
        }
        // If the entire chunk failed without advancing, stop — otherwise we'd
        // re-fetch and re-fail the same rows forever. Next restart retries.
        if (lastId === startOfChunk) {
          console.warn('[ActionProcessor] Backlog stuck — no events processed in chunk, bailing out')
          break
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
              if (err instanceof StaleTokenError) {
                console.warn(`[ActionProcessor] Skipping stale event ${rawEventId}: ${(err as Error).message}`)
                lastId = rawEventId
              } else {
                console.error(`[ActionProcessor] Failed to process event ${rawEventId}:`, err)
                // Don't advance lastId — retry on next message/restart
              }
            }
          }
        }
      })

    })()

    return {
      started,
      async stop() {
        stopRequested = true
        clearInterval(idleHeartbeat)
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
    } else if (err instanceof StaleTokenError) {
      // Token doesn't exist on current L1 contract — skip silently
      console.warn(`[ActionProcessor] Skipping stale action (sender=${rawAction.senderId}): ${err.message}`)
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

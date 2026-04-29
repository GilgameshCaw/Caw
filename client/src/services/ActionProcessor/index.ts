//src/services/ActionProcessor/index.ts
import { ActionType as PrismaActionType } from '@prisma/client'
import { prisma } from '../../prismaClient'
import { Service } from '../../Service'
import Redis from 'ioredis'
import { z } from 'zod'
import { createOrFindAction, ensureActionExists } from './actionCreation'
import { processDomainEffects, resolveActionUsers } from './domainProcessor'
import type { RawAction } from './types'
import { StaleTokenError } from '../UserService'
import { CawNotFoundError } from './actionHandlers'
import { CAW_ACTIONS_ADDRESS } from '../../abi/addresses'
import { span } from '../../utils/trace'
import getActionType from '../../abi/getActionType'

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
    // One span per processed action — gives a per-action-type latency
    // breakdown in SigNoz so we can see e.g. "tip actions are taking 800ms,
    // likes are 50ms" without sifting through Prisma-only spans.
    await span('actionprocessor.handle', {
      'action.type': getActionType(Number(rawAction.actionType)),
      'action.sender': Number(rawAction.senderId),
      'raw_event.id': rawId,
    }, async () => {
      // Resolve users BEFORE opening the interactive transaction. Prisma's
      // default 5s tx timeout was tripping when a batch of N actions opened
      // N parallel transactions and each called findOrCreateUser inside —
      // Postgres row-locks on the same user serialized them past 5s. User
      // creation is idempotent, so it doesn't need tx semantics anyway.
      const resolved = await resolveActionUsers(rawAction)

      // 15s tx timeout (default 5s) — safety net for slow Postgres bursts and
      // pool-saturation waits. resolveActionUsers above eliminates the main
      // hazard (RPC inside tx); this guards against the next-most-likely
      // cause: contention on hot rows + pool exhaustion under load.
      await prisma.$transaction(async (tx) => {
        const { action, shouldProcessDomain } = await createOrFindAction(tx, rawId, chainId, rawAction)
        if (!shouldProcessDomain) return
        const validAction = await ensureActionExists(tx, rawId, action)
        await processDomainEffects(tx, validAction, rawAction, resolved)
      }, { timeout: 15_000 })
    })
  } catch (err: any) {
    // If we hit a race condition, retry once to process the action created by another process
    if (err.message?.includes('Action already exists (race condition)')) {
      console.log('[ActionProcessor] Race condition detected, retrying to process existing action...')
      try {
        const resolved = await resolveActionUsers(rawAction)
        await prisma.$transaction(async (tx) => {
          const { action, shouldProcessDomain } = await createOrFindAction(tx, rawId, chainId, rawAction)
          if (!shouldProcessDomain) return
          const validAction = await ensureActionExists(tx, rawId, action)
          await processDomainEffects(tx, validAction, rawAction, resolved)
        }, { timeout: 15_000 })
        console.log('[ActionProcessor] Successfully processed action after race condition retry')
      } catch (retryErr) {
        console.error('[ActionProcessor] Failed to handle raw action after retry:', retryErr)
      }
    } else if (err instanceof StaleTokenError) {
      // Token doesn't exist on current L1 contract — skip silently
      console.warn(`[ActionProcessor] Skipping stale action (sender=${rawAction.senderId}): ${err.message}`)
    } else if (err instanceof CawNotFoundError) {
      // Like/reply/tip targets a caw we don't have indexed — most often
      // because the local node started after the original caw, was
      // running a different clientId at the time, or is processing a
      // backfill from another instance's chain history. Action row is
      // still recorded above; the side-effect (Like/Reply/Tip row) just
      // can't attach. Quiet warn, not red.
      console.warn(`[ActionProcessor] Skipping action targeting unknown caw (user=${err.userId} cawonce=${err.cawonce}, type=${getActionType(Number(rawAction.actionType))})`)
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

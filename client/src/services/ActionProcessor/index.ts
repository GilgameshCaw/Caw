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
// Static imports — were previously dynamic (`await import('../StakeLedger')`)
// inside hot-path try/catches. The dynamic form trips
// ERR_UNSUPPORTED_DIR_IMPORT under Node 22 + tsx/cjs because Node's runtime
// resolver doesn't probe `index.ts` for directory imports the way tsx's
// rewriter does for static imports. No circular-import risk: StakeLedger
// only `type`-imports from ActionProcessor/types (erased at compile time).
// Reported by Zin running the standard .nvmrc environment.
import { verifyMultiplier, recordAction } from '../StakeLedger'

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
async function handleRawEvent(raw: { id: number, chainId: number, data: any, blockNumber: bigint, logIndex: number, transactionHash: string, topics: any, createdAt: Date }) {
  const list = Array.isArray(raw.data) ? raw.data : [raw.data];
  // ActionsProcessed event signature: (uint32 indexed networkId, uint32
  // indexed validatorId, uint16 actionCount, bytes32 batchHash). We only
  // need validatorId for ledger attribution (validator tip recipient).
  // topics[0] = sig hash, topics[1] = networkId, topics[2] = validatorId.
  const topics = Array.isArray(raw.topics) ? raw.topics : []
  let validatorId = 0
  if (topics[2]) {
    try { validatorId = Number(BigInt(String(topics[2]))) } catch {}
  }
  let actionIndex = 0
  for (const rawAction of list) {
    if (!filterAction(rawAction)) {
      actionIndex++
      continue
    }
    await handleRawAction(raw, rawAction, validatorId, actionIndex);
    actionIndex++
  }

  // After all actions in this ActionsProcessed event are applied, ask
  // chain for rewardMultiplier() once and assert equality with our
  // running state. Outside any DB tx — the RPC must not extend a tx
  // timeout. Best-effort: a transient RPC failure logs a warn and
  // skips the check; the daily reconciler is the deeper safety net.
  try {
    await verifyMultiplier()
  } catch (err) {
    console.warn('[ActionProcessor] StakeLedger verifyMultiplier failed:', err)
  }
}


async function handleRawAction(raw: { id: number, chainId: number, blockNumber: bigint, logIndex: number, transactionHash: string, createdAt: Date }, rawAction: RawAction, validatorId: number, actionIndex: number): Promise<void> {
  const rawId = raw.id
  const chainId = raw.chainId
  await span('actionprocessor.handle', {
    'action.type': getActionType(Number(rawAction.actionType)),
    'action.sender': Number(rawAction.senderId),
    'raw_event.id': rawId,
  }, async () => {
    // Resolve users BEFORE opening any transaction. Prisma's default 5s tx
    // timeout was tripping when a batch of N actions opened N parallel
    // transactions and each called findOrCreateUser inside — Postgres
    // row-locks on the same user serialized them past 5s. User creation is
    // idempotent, so it doesn't need tx semantics anyway.
    let resolved
    try {
      resolved = await resolveActionUsers(rawAction)
    } catch (err: any) {
      if (err instanceof StaleTokenError) {
        console.warn(`[ActionProcessor] Skipping stale action (sender=${rawAction.senderId}): ${err.message}`)
        return
      }
      console.error('[ActionProcessor] Failed to resolve action users:', err)
      return
    }

    // Tx1: persist the Action row. This MUST land independently of domain
    // processing — the Action row is the local mirror of an on-chain fact
    // and is the evidence ValidatorService.resolveCawonceUsed uses to tell
    // "we already processed this cawonce" from "a different action collided
    // on this cawonce." If we let domain failures roll back the Action row
    // (the previous behavior), the next time the same sender tries to use
    // the same cawonce we can't tell those cases apart and surface a
    // spurious "Cawonce already used" to the user.
    let action
    let shouldProcessDomain
    try {
      const result = await prisma.$transaction(async (tx) => {
        return await createOrFindAction(tx, rawId, chainId, rawAction, {
          txHash: raw.transactionHash,
          blockNumber: Number(raw.blockNumber),
          validatorId,
        })
      }, { timeout: 30_000 })
      action = result.action
      shouldProcessDomain = result.shouldProcessDomain
    } catch (err: any) {
      // P2002 from createOrFindAction: another worker created this Action
      // row first. Recover by treating it as "exists, may need domain
      // processing" — the existence-check path inside createOrFindAction
      // would have done the same on a fresh call.
      if (err.message?.includes('Action already exists (race condition)')) {
        const existing = await prisma.action.findFirst({
          where: { chainId, senderId: rawAction.senderId, cawonce: rawAction.cawonce },
        })
        if (!existing) {
          console.error('[ActionProcessor] Race-condition recovery failed: Action vanished after P2002')
          return
        }
        action = existing
        shouldProcessDomain = true
      } else {
        console.error('[ActionProcessor] Failed to persist Action row:', err)
        return
      }
    }

    if (!shouldProcessDomain) return

    // Tx2: domain side effects (Like/Follow/Reply/Tip rows, count bumps,
    // hashtags, notifications). If this throws — most often
    // CawNotFoundError because the target caw isn't yet indexed locally —
    // the rollback is contained to domain rows. The Action row from Tx1
    // stays put, and a future re-run (manual rescan, or anything that
    // re-feeds this rawId) will re-enter via createOrFindAction's
    // existing-action path and call processDomainEffects again because
    // checkDomainObjectExists will return false.
    //
    // Deadlock retry: concurrent indexer workers updating shared count
    // columns (User followingCount/followerCount, Caw likeCount, etc.) can
    // deadlock when two transactions acquire row locks in opposite orders.
    // Postgres surfaces this as SQLSTATE 40P01 → Prisma error code P2034.
    // We retry the whole Tx2 a small number of times with jittered backoff
    // so a transient deadlock victim still lands its domain rows instead of
    // leaving an Action row without its Like/Follow/etc.
    try {
      let lastErr: any = null
      const MAX_TX2_RETRIES = 3
      for (let attempt = 0; attempt <= MAX_TX2_RETRIES; attempt++) {
        try {
          await prisma.$transaction(async (tx) => {
            const validAction = await ensureActionExists(tx, rawId, action)
            await processDomainEffects(tx, validAction, rawAction, resolved)
          }, { timeout: 30_000 })
          lastErr = null
          break
        } catch (err: any) {
          // P2034 is Prisma's wrapper for postgres 40P01 (deadlock_detected).
          // The error message also contains "deadlock detected" on raw paths,
          // so match either to be safe.
          const isDeadlock = err?.code === 'P2034'
            || /deadlock detected/i.test(err?.message || '')
          if (isDeadlock && attempt < MAX_TX2_RETRIES) {
            const backoffMs = 20 + Math.floor(Math.random() * 80) * (attempt + 1)
            console.warn(`[ActionProcessor] Tx2 deadlock (attempt ${attempt + 1}/${MAX_TX2_RETRIES + 1}), retrying in ${backoffMs}ms`)
            await new Promise(r => setTimeout(r, backoffMs))
            lastErr = err
            continue
          }
          lastErr = err
          throw err
        }
      }
      if (lastErr) throw lastErr
    } catch (err: any) {
      if (err instanceof CawNotFoundError) {
        // Like/reply/tip targets a caw we don't have indexed — most often
        // because the local node started after the original caw, was
        // running a different clientId at the time, or the target caw
        // hasn't been processed yet (its own RawEvent is later in the
        // backlog or also failed domain processing on a prior pass).
        // Action row is recorded; the side-effect didn't land. Quiet warn.
        console.warn(`[ActionProcessor] Domain processing skipped for unknown caw (user=${err.userId} cawonce=${err.cawonce}, type=${getActionType(Number(rawAction.actionType))})`)
        return
      }
      console.error('[ActionProcessor] Domain processing failed (Action row persisted):', err)
    }

    // Tx3: StakeLedger snapshot. Independent commit per
    // feedback_two_tx_split_pattern — a ledger bug must NOT roll back
    // the domain rows from Tx2. Ledger writes are append-only mirror
    // facts and tolerate replay; the (blockNumber, logIndex,
    // actionIndex) primary key dedupes RewardMultiplierSnapshot. On
    // ledger failure we log and continue — the per-event multiplier
    // checksum in handleRawEvent will halt the writer if state has
    // drifted.
    try {
      await prisma.$transaction(async (tx) => {
        await recordAction(tx, {
          rawAction,
          validatorId,
          blockNumber: raw.blockNumber,
          blockTimestamp: raw.createdAt,
          txHash: raw.transactionHash,
          logIndex: raw.logIndex,
          actionIndex,
        })
      }, { timeout: 30_000 })
    } catch (err: any) {
      console.error('[ActionProcessor] StakeLedger snapshot failed (domain rows committed):', err?.message ?? err)
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

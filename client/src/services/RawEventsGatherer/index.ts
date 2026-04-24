// src/services/RawEventsGatherer/index.ts
import { z } from 'zod'
import Redis from 'ioredis'
import { Service } from '../../Service'
import listenForRawEvents, { RawEventInput } from './listenForRawEvents'
import { convertBigIntsToStrings } from "./utils";
import { CAW_ACTIONS_ADDRESS } from '../../abi/addresses'
import { prisma } from '../../prismaClient'

const Config = z.object({
  chainId:         z.number().int().positive(),
  rpcUrl:          z.string(), // Validated at runtime after env var substitution
  redisUrl:        z.string().optional().default('redis://127.0.0.1:6379'),
  startBlock:      z.number().int().optional() // If set, never scan earlier than this block
})

type Config = z.infer<typeof Config>

/**
 * RawEventsGatherer service
 */
export const rawEventsGathererService: Service = {
  name: 'RawEventsGatherer',

  validateConfig(cfg: unknown) {
    const result = Config.safeParse(cfg)
    return result.success
      ? []
      : result.error.errors.map(e => new Error(`ZodError: ${e.message}`))
  },

  start(configParam: unknown, ctx: import('../../Service').HeartbeatContext) {
    const cfg = Config.parse(configParam)
    ctx.declareLoop('poll', 90_000) // 3× the 15s poll interval + buffer
    // Prefer environment variable for RPC URL (never commit API keys to config)
    const rpcUrl = process.env.L2_RPC_URL || cfg.rpcUrl
    const { chainId, redisUrl } = cfg

    if (!rpcUrl || rpcUrl.includes('${')) {
      throw new Error('Missing L2_RPC_URL in environment variables')
    }

    const redis = new Redis(redisUrl)
    let stopListener: () => void

    const started = (async () => {
      await prisma.$connect()

      const getLast = async () => {
        const last = await prisma.rawEvent.findFirst({
          where: { chainId, contractAddress: CAW_ACTIONS_ADDRESS },
          orderBy: [
            { blockNumber: 'desc' },
            { logIndex:    'desc' }
          ]
        })
        return last
          ? {
              blockNumber: Number(last.blockNumber),
              logIndex:    last.logIndex,
              parentHash:  last.parentHash
            }
          : null
      }

      const store = async (e: RawEventInput) => {
        return await prisma.rawEvent.upsert({
          where: {
            blockNumber_logIndex_transactionHash: {
              blockNumber:     e.blockNumber,
              logIndex:        e.logIndex,
              transactionHash: e.transactionHash
            }
          },
          update: {},
          create: {
            blockNumber:     e.blockNumber,
            chainId:         e.chainId,
            logIndex:        e.logIndex,
            transactionHash: e.transactionHash,
            parentHash:      e.parentHash,
            data:            convertBigIntsToStrings(e.data),
            topics:          e.topics,
            contractAddress: CAW_ACTIONS_ADDRESS
          }
        })
      }

      const storeAndPublish = async (e: RawEventInput) => {
        const event = await store(e)
        // publish the rawEvent’s PK so subscribers know there’s work
        await redis.publish('raws', event.id.toString())
      }

      // Bulk variant — single createMany + single findMany, one publish per
      // resulting row (ActionProcessor's consumer expects per-row messages).
      // An on-chain ActionsProcessed event with 24 packed actions previously
      // did 24 sequential UPSERTs here; now it does one INSERT and one lookup.
      //
      // Idempotency: `skipDuplicates: true` handles redelivery (same rows
      // inserted twice are a no-op on the second call, matching the old
      // upsert-update:{} semantics).
      //
      // Double-publish safety: if two gatherer instances race briefly during
      // a watchdog-restart, one might include rows the other just inserted
      // in its "newly after maxBefore" window. ActionProcessor dedupes on
      // rawEventId > lastId (index.ts:94), so a double-publish is harmless.
      const storeBatchAndPublish = async (events: RawEventInput[]) => {
        if (events.length === 0) return

        // Watermark the current max id so we can identify what we just
        // inserted. Reads the max from the indexed primary key — cheap.
        const before = await prisma.rawEvent.findFirst({
          orderBy: { id: 'desc' },
          select: { id: true },
        })
        const maxBefore = before?.id ?? 0

        await prisma.rawEvent.createMany({
          data: events.map(e => ({
            blockNumber:     e.blockNumber,
            chainId:         e.chainId,
            logIndex:        e.logIndex,
            transactionHash: e.transactionHash,
            parentHash:      e.parentHash,
            data:            convertBigIntsToStrings(e.data),
            topics:          e.topics,
            contractAddress: CAW_ACTIONS_ADDRESS,
          })),
          skipDuplicates: true,
        })

        // Fetch new rows in id order so downstream ActionProcessor sees them
        // in the same sequence we computed the parentHash chain in.
        const created = await prisma.rawEvent.findMany({
          where: { id: { gt: maxBefore }, chainId, contractAddress: CAW_ACTIONS_ADDRESS },
          orderBy: { id: 'asc' },
          select: { id: true },
        })

        for (const { id } of created) {
          await redis.publish('raws', id.toString())
        }
      }

      const listener = await listenForRawEvents({
        rpcUrl,
        chainId,
        contractAddress: CAW_ACTIONS_ADDRESS,
        startBlock: cfg.startBlock,
        rawEventsProvider: {
          getLastProcessedEvent: getLast,
          storeEvent:            storeAndPublish,
          storeBatch:            storeBatchAndPublish,
        },
        onTick: () => ctx.heartbeat('poll'),
      })

      stopListener = listener.stop
    })()

    return {
      started,
      async stop() {
        if (stopListener) stopListener()
        await prisma.$disconnect()
      },
      stats: async () => `Total raw events: ${await prisma.rawEvent.count()}`
    }
  }
}


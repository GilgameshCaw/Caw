// src/services/RawEventsGatherer/index.ts
import { z } from 'zod'
import Redis from 'ioredis'
import { Service } from '../../Service'
import listenForRawEvents, { RawEventInput } from './listenForRawEvents'
import { convertBigIntsToStrings } from "./utils";
import { CAW_ACTIONS_ADDRESS, CAW_ACTIONS_ERC1271_ADDRESS } from '../../abi/addresses'
import { prisma } from '../../prismaClient'
import { getL2WsRpcUrl } from '../../utils/rpcProvider'
import { getNetworkId } from '../../utils/networkId'

const Config = z.object({
  chainId:         z.number().int().positive(),
  rpcUrl:          z.string(), // Validated at runtime after env var substitution
  redisUrl:        z.string().optional().default('redis://127.0.0.1:6379'),
  startBlock:      z.number().int().optional(), // Manual override — overrides creationBlock
  networkId:        z.number().int().positive().optional(), // Defaults to CLIENT_ID env var
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
    const rpcUrl = getL2WsRpcUrl() || cfg.rpcUrl
    const { chainId, redisUrl } = cfg

    // Resolve networkId — this instance scopes to one network. Falls through
    // config.json → CLIENT_ID env var. No legacy fallback to 1: a missing
    // value is a real bug (silently watching the wrong network's events
    // cross-contaminates the indexer's database) and should fail loud.
    //
    // Note: Number(undefined) is NaN, and NaN ?? x does NOT fall through
    // because NaN isn't nullish. Coerce with explicit env.CLIENT_ID check.
    const envClientIdRaw = getNetworkId()
    const envClientId = envClientIdRaw ? Number(envClientIdRaw) : undefined
    const networkId = cfg.networkId ?? (envClientId && Number.isFinite(envClientId) ? envClientId : undefined)
    if (networkId === undefined || !Number.isFinite(networkId) || networkId <= 0) {
      throw new Error('RawEventsGatherer: CLIENT_ID is required (set it in client/.env or config.json)')
    }

    if (!rpcUrl || rpcUrl.includes('${')) {
      throw new Error('Missing L2_RPC_URL in environment variables')
    }

    const redis = new Redis(redisUrl)
    let stopListener: () => void

    const started = (async () => {
      await prisma.$connect()

      // Build the set of known contract addresses for this chain so the high-water
      // mark query covers both CawActions and CawActionsERC1271 rows. Using the
      // max across both avoids re-scanning already-processed blocks on restart.
      const knownContractAddresses = [CAW_ACTIONS_ADDRESS as string]
      if (CAW_ACTIONS_ERC1271_ADDRESS) knownContractAddresses.push(CAW_ACTIONS_ERC1271_ADDRESS)

      const getLast = async () => {
        const last = await prisma.rawEvent.findFirst({
          where: { chainId, contractAddress: { in: knownContractAddresses } },
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
            contractAddress: e.contractAddress
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
            contractAddress: e.contractAddress,
          })),
          skipDuplicates: true,
        })

        // Fetch new rows in id order so downstream ActionProcessor sees them
        // in the same sequence we computed the parentHash chain in.
        const created = await prisma.rawEvent.findMany({
          where: { id: { gt: maxBefore }, chainId, contractAddress: { in: knownContractAddresses } },
          orderBy: { id: 'asc' },
          select: { id: true },
        })

        for (const { id } of created) {
          await redis.publish('raws', id.toString())
        }
      }

      // Resolve the fresh-DB start block. Precedence, strongest to weakest:
      //   1. cfg.startBlock — explicit override in config.json, for
      //      backfill/repair or short-circuiting history.
      //   2. Client.creationBlock in DB — canonical "this client was created
      //      at block N" for the client we're indexing. Populated from
      //      the CawNetworkManager's on-chain CawNetwork struct once the
      //      struct carries that field (pending a redeploy). For now
      //      seeded manually via `npx tsx scripts/seed-network-creation-block.ts`.
      //   3. undefined — listenForRawEvents falls back to "current head",
      //      which is the today-behavior for an unknown client.
      //
      // Once a RawEvent lands in the DB, getLastProcessedEvent takes over
      // and this resolution is never used again. So it only matters on
      // cold-start of a fresh DB.
      let resolvedStartBlock: number | undefined = cfg.startBlock
      if (resolvedStartBlock === undefined) {
        try {
          const client = await prisma.network.findUnique({
            where: { id: networkId },
            select: { creationBlock: true },
          })
          if (client?.creationBlock != null) {
            resolvedStartBlock = Number(client.creationBlock)
            console.log(`[RawEventsGatherer] Using Network.creationBlock=${resolvedStartBlock} for networkId=${networkId}`)
          }
        } catch (err: any) {
          console.warn(`[RawEventsGatherer] Failed to read Network.creationBlock: ${err?.message}`)
        }
      }

      const listener = await listenForRawEvents({
        rpcUrl,
        chainId,
        networkId,
        contractAddress: CAW_ACTIONS_ADDRESS,
        startBlock: resolvedStartBlock,
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


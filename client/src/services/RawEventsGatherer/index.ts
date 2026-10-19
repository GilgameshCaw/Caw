// src/services/RawEventsGatherer/index.ts
import { z } from 'zod'
import Redis from 'ioredis'
import type { Log } from 'ethers'
import { Service } from '../../Service'
import listenForRawEvents, { RawEventInput, getRawEventsPollIntervalMs } from './listenForRawEvents'
import { convertBigIntsToStrings } from "./utils";
import { CAW_ACTIONS_ADDRESS, CAW_ACTIONS_ERC1271_ADDRESS } from '../../abi/addresses'
import { prisma } from '../../prismaClient'
import { getL2WsRpcUrl } from '../../utils/rpcProvider'
import { getNetworkId } from '../../utils/networkId'

const Config = z.object({
  chainId:         z.number().int().positive(),
  rpcUrl:          z.string(), // Validated at runtime after env var substitution
  redisUrl:        z.string().optional().default('redis://127.0.0.1:6379'),
  startBlock:      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), // Reviewed floor on the indexed chain; no database fallback
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
    // Derive the watchdog timeout from the interval the loop actually runs at
    // (RAW_EVENTS_POLL_MS, 30s default) rather than a constant. The 90s here
    // was 3x the 15s interval when it was written in 73dfcc9; d19c3f8 later
    // took the interval to 30s and this line kept the old number, leaving no
    // buffer at all. 4x / at least 3 minutes, matching 2848b87.
    const pollIntervalMs = getRawEventsPollIntervalMs()
    ctx.declareLoop('poll', Math.max(pollIntervalMs * 4, 180_000))
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

      // Batched to keep any single query's OR clause bounded -- the
      // historical rescan intentionally has no upper cap on how many events
      // it can cover in one pass (see the "10K * 100K windows" comment
      // above, for multi-month-gap operators), so `events` here can run into
      // the thousands. One query with a several-thousand-clause OR is the
      // kind of thing that's fine in dev and slow or memory-heavy on a
      // loaded production Postgres; chunking keeps each round trip small
      // and predictable regardless of how large the rescan range is.
      // 5000 is a conservative upper-bound estimate, not a measured
      // single-rescan size -- checked this node's cumulative RawEvent
      // count (622,843 rows total) as a sanity ceiling, but that's lifetime
      // volume, not what any one historical rescan actually covers (a
      // normal restart resumes from getLastProcessedEvent and only
      // rescans a small trailing range; checked directly on cawnest.com
      // and its most recent restart's rescan was near-empty). A worst-case
      // full rescan (e.g. after a startBlock reset) could in
      // principle put `past` somewhere in that lifetime-volume range, which
      // is what this batch size is sized against. Sequential batches of
      // 500 would mean over a thousand round trips in that scenario; 5000
      // keeps it to roughly 125 while keeping each query's OR clause well
      // clear of Postgres parameter/plan limits. Deliberately sequential
      // rather than parallelized -- concurrent batches would each hold a
      // Prisma pool connection at once, and this runs during service
      // startup alongside other initialization work sharing the same pool
      // (connection_limit=70 in this node's DATABASE_URL); a burst of
      // concurrent queries here risks starving that startup path instead.
      const COUNT_EXISTING_BATCH_SIZE = 5000
      const countExisting = async (events: Log[]) => {
        if (events.length === 0) return 0
        let total = 0
        for (let i = 0; i < events.length; i += COUNT_EXISTING_BATCH_SIZE) {
          const batch = events.slice(i, i + COUNT_EXISTING_BATCH_SIZE)
          // OR over the same [blockNumber, logIndex, transactionHash]
          // unique key RawEvent enforces, so this counts exactly the events
          // already stored -- no false positives from a coincidental
          // transactionHash match alone, since two different logs never
          // share the full triple. ethers' Log exposes the position as
          // `.index` (v6); fall back to `.logIndex` for any provider shim
          // that still uses the old name, matching how the rest of this
          // service reads it.
          total += await prisma.rawEvent.count({
            where: {
              OR: batch.map(e => ({
                blockNumber: e.blockNumber,
                logIndex: (e as any).index ?? (e as any).logIndex ?? 0,
                transactionHash: e.transactionHash,
              })),
            },
          })
        }
        return total
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

      // Network.creationBlock comes from the L1 NetworkManager. It has no
      // storage-chain provenance and must not become an L2 scan floor.
      // Require an explicitly reviewed floor for the selected indexed chain.
      // The listener rejects an absent/invalid floor before opening its RPC.
      const resolvedStartBlock: number | undefined = cfg.startBlock

      // Completion is scoped to this exact scan request. Legacy flags carry
      // no floor/address provenance and are intentionally not consulted.
      // This does not authenticate a deployment generation or a reorg anchor.
      const floorKey = 'raw-events-gatherer:floor-v2:' + JSON.stringify([
        chainId, networkId, resolvedStartBlock,
        CAW_ACTIONS_ADDRESS.toLowerCase(),
        CAW_ACTIONS_ERC1271_ADDRESS?.toLowerCase() ?? null,
      ])

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
          // Persist only under the current floor and contract scope. A scope
          // change forces backfill; it does not delete existing event rows.
          isFloorFilled: async () => {
            const row = await prisma.chainData.findUnique({ where: { key: floorKey } })
            return (row?.value as any)?.filled === true
          },
          markFloorFilled: async () => {
            await prisma.chainData.upsert({ where: { key: floorKey }, update: { value: { filled: true } }, create: { key: floorKey, value: { filled: true } } })
          },
          countExisting,
        },
        onTick: () => ctx.heartbeat('poll'),
        onStall: (reason) => ctx.heartbeatDegraded('poll', reason),
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


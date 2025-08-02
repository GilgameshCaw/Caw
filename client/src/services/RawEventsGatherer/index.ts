// src/services/RawEventsGatherer/index.ts
import { z } from 'zod'
import Redis from 'ioredis'
import { Service } from '../../Service'
import listenForRawEvents, { RawEventInput } from './listenForRawEvents'
import { CAW_ACTIONS_ADDRESS } from '../../abi/addresses'
import { prisma } from '../../prismaClient'

const Config = z.object({
  chainId:         z.number().int().positive(),
  rpcUrl:          z.string().regex(/^wss?:\/\//),
  redisUrl:        z.string().optional().default('redis://127.0.0.1:6379')
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

  start(configParam: unknown) {
    const { rpcUrl, chainId, redisUrl } = Config.parse(configParam)
    const redis = new Redis(redisUrl)
    let stopListener: () => void

    const started = (async () => {
      await prisma.$connect()

      const getLast = async () => {
        const last = await prisma.rawEvent.findFirst({
          where: { chainId },
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
        console.log("STORE: ", e)
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
            data:            e.data,
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

      const listener = await listenForRawEvents({
        rpcUrl,
        chainId,
        contractAddress: CAW_ACTIONS_ADDRESS,
        rawEventsProvider: {
          getLastProcessedEvent: getLast,
          storeEvent:            storeAndPublish
        }
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


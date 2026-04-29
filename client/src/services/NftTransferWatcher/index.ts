// src/services/NftTransferWatcher/index.ts
//
// Watches Transfer events on the L1 Names/Profile NFT contract and reactively
// updates User.address in the DB. Replaces the full-scan ownership check
// pattern that syncTokensOwnedByWallet still does just-in-time.
//
// Once this service is running, profile pickers and /user/:tokenId pages
// stay accurate without any poll-style scan of all users.
import 'dotenv/config'
import { z } from 'zod'
import { ethers } from 'ethers'
import Redis from 'ioredis'
import { makeJsonRpcProvider, getL1HttpRpcUrl } from '../../utils/rpcProvider'
import { Service } from '../../Service'
import { prisma } from '../../prismaClient'
import { CAW_NAMES_ADDRESS } from '../../abi/addresses'
import { findOrCreateUser, StaleTokenError } from '../UserService'

const Config = z.object({
  l1RpcUrl:            z.string().optional(),
  chainId:             z.number().int().positive().default(11155111), // Sepolia today, mainnet later
  cawProfileAddress:   z.string().optional(),
  pollIntervalMs:      z.number().int().positive().default(30_000),
  // First-run start block. Once we land #4 (per-client checkpointing) this
  // becomes redundant — discovered from the ClientCreated event. For now it's
  // a config knob.
  startBlock:          z.number().int().optional(),
  // Max blocks per poll — guards against millions-of-logs requests if the
  // service falls far behind.
  maxBlocksPerPoll:    z.number().int().positive().default(10_000),
  redisUrl:            z.string().optional().default('redis://127.0.0.1:6379'),
})

type Config = z.infer<typeof Config>

// ERC-721 standard Transfer event.
const TRANSFER_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]

// Redis key storing the last block we've processed. Interim home until the
// per-client checkpoint table lands as part of #4 in the scalability plan.
const checkpointKey = (chainId: number, contract: string) =>
  `nft-transfer-watcher:${chainId}:${contract.toLowerCase()}:last-block`

export const nftTransferWatcherService: Service = {
  name: 'NftTransferWatcher',

  validateConfig(cfg: unknown) {
    const result = Config.safeParse(cfg)
    return result.success
      ? []
      : result.error.errors.map(e => new Error(`ZodError: ${e.message}`))
  },

  start(configParam: unknown, ctx: import('../../Service').HeartbeatContext) {
    const cfg = Config.parse(configParam)
    ctx.declareLoop('poll', Math.max(cfg.pollIntervalMs * 3, 120_000))

    const rpcUrl = getL1HttpRpcUrl(cfg.l1RpcUrl)
    const contractAddress = cfg.cawProfileAddress || CAW_NAMES_ADDRESS
    const redis = new Redis(cfg.redisUrl)

    let alive = true
    let pollTimer: ReturnType<typeof setTimeout> | null = null

    const started = (async () => {
      if (!rpcUrl) throw new Error('[NftTransferWatcher] No L1 RPC URL configured')
      await prisma.$connect()

      const provider = makeJsonRpcProvider(rpcUrl, cfg.chainId)
      const contract = new ethers.Contract(contractAddress, TRANSFER_ABI, provider)
      console.log(`[NftTransferWatcher] Started — contract=${contractAddress}, chainId=${cfg.chainId}, rpc=${rpcUrl.slice(0, 40)}...`)

      // Resolve start block from checkpoint, then configured startBlock, then
      // current head (never scan from 0 — blockchain-wide scans are never
      // what you want for this use case).
      const cpKey = checkpointKey(cfg.chainId, contractAddress)
      let lastBlock: number
      const cp = await redis.get(cpKey)
      if (cp) {
        lastBlock = parseInt(cp, 10)
        console.log(`[NftTransferWatcher] Resuming from checkpoint block ${lastBlock}`)
      } else if (cfg.startBlock !== undefined) {
        lastBlock = cfg.startBlock
        console.log(`[NftTransferWatcher] No checkpoint — starting from configured startBlock ${lastBlock}`)
      } else {
        lastBlock = await provider.getBlockNumber()
        console.log(`[NftTransferWatcher] No checkpoint — starting from current head ${lastBlock}`)
      }

      const poll = async () => {
        if (!alive) return
        try {
          const currentBlock = await provider.getBlockNumber()
          if (currentBlock > lastBlock) {
            const fromBlock = lastBlock + 1
            const toBlock = Math.min(currentBlock, fromBlock + cfg.maxBlocksPerPoll - 1)

            const events = await contract.queryFilter(
              contract.filters.Transfer(),
              fromBlock,
              toBlock,
            )

            if (events.length > 0) {
              console.log(`[NftTransferWatcher] Processing ${events.length} Transfer event(s) in blocks ${fromBlock}..${toBlock}`)
            }

            for (const ev of events) {
              const args = (ev as ethers.EventLog).args
              if (!args) continue
              const fromAddr = (args[0] as string).toLowerCase()
              const toAddr = (args[1] as string).toLowerCase()
              const tokenId = Number(args[2])

              // Tier 3 of the "RPC out of API request handlers" refactor:
              // /api/users/by-token, /api/auth/verify, etc. now return 202 on
              // a DB miss instead of falling back to RPC. That means THIS
              // service is the authoritative path for getting fresh-mint and
              // post-transfer User rows into the DB. If we skip rows that
              // don't yet exist, the API loops forever on 202.
              //
              // For Transfer-from-zero (mint), call findOrCreateUser to read
              // the L1 metadata (owner + username) and create the row. For
              // a regular transfer, update the address; if the row is missing
              // (we joined the chain late), fall back to findOrCreateUser to
              // backfill it.
              try {
                const isMint = fromAddr === '0x0000000000000000000000000000000000000000'
                const user = await prisma.user.findUnique({ where: { tokenId } })

                if (!user) {
                  if (isMint) {
                    console.log(`[NftTransferWatcher] Mint detected — creating User row for tokenId=${tokenId} owner=${toAddr}`)
                  } else {
                    console.log(`[NftTransferWatcher] Transfer for unindexed tokenId=${tokenId} (joined late) — backfilling`)
                  }
                  try {
                    await findOrCreateUser(tokenId)
                  } catch (err: any) {
                    if (err instanceof StaleTokenError) {
                      // Token doesn't exist on the L1 contract this watcher is
                      // pointed at — old deployment, ignore.
                      console.warn(`[NftTransferWatcher] tokenId=${tokenId} not on current L1 contract — skipping`)
                      continue
                    }
                    throw err
                  }
                  // findOrCreateUser writes the L1 owner; if the latest event
                  // says someone else now owns it, apply that on top.
                  const refreshed = await prisma.user.findUnique({ where: { tokenId } })
                  if (refreshed && refreshed.address.toLowerCase() !== toAddr) {
                    await prisma.user.update({
                      where: { tokenId },
                      data: { address: toAddr },
                    })
                  }
                } else if (user.address.toLowerCase() !== toAddr) {
                  console.log(`[NftTransferWatcher] tokenId=${tokenId} transferred: ${user.address} → ${toAddr}`)
                  await prisma.user.update({
                    where: { tokenId },
                    data: { address: toAddr },
                  })
                }
              } catch (err: any) {
                console.warn(`[NftTransferWatcher] Failed to apply transfer for tokenId=${tokenId}:`, err?.message)
              }
            }

            lastBlock = toBlock
            await redis.set(cpKey, String(lastBlock))
          }
          ctx.heartbeat('poll')
        } catch (err: any) {
          console.error('[NftTransferWatcher] Poll error:', err?.message || err)
        } finally {
          if (alive) pollTimer = setTimeout(poll, cfg.pollIntervalMs)
        }
      }

      poll()
    })()

    return {
      started,
      async stop() {
        alive = false
        if (pollTimer) clearTimeout(pollTimer)
        await redis.quit()
      },
      async stats() {
        const cpKey = checkpointKey(cfg.chainId, contractAddress)
        const cp = await redis.get(cpKey)
        return `last processed block: ${cp ?? '(none)'}`
      },
    }
  },
}

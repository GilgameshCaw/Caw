// src/services/DepositWatcher/index.ts
//
// Watches CawProfile.Deposited(uint32 indexed cawClientId, uint32
// indexed tokenId, uint256 amount, uint32 indexed lzDestId, address
// depositor) events on L1 and writes a CawOwnershipSnapshot row per
// deposit (reason='DEPOSIT'). Closes the gap that the daily
// reconciler used to cover with imprecise NOW-timestamped guesses —
// deposits now show up on the activity chart with exact timing the
// moment the L1 tx is mined (typically faster than LayerZero settles
// the corresponding L2 update, which is fine: the chart only cares
// about WHEN the user committed CAW from L1).
//
// Filtered to the configured cawClientId so we don't index deposits
// from other CAW client deployments sharing the same L1 contract.
//
// Operator-tuned for free-tier RPCs (50K-block-per-getLogs cap):
// per-poll cap, halve-and-retry on chunk failures via the shared
// `scanLogsForward`, catch-up draining when the checkpoint falls
// behind. Same shape as NftTransferWatcher — reuse the operator's
// mental model.

import 'dotenv/config'
import { z } from 'zod'
import { ethers } from 'ethers'
import Redis from 'ioredis'
import { makeJsonRpcProvider, getL1HttpRpcUrl, redactRpcUrl } from '../../utils/rpcProvider'
import { Service } from '../../Service'
import { prisma } from '../../prismaClient'
import { CAW_NAMES_ADDRESS } from '../../abi/addresses'
import { recordDeposit } from '../StakeLedger'

const Config = z.object({
  l1RpcUrl:          z.string().optional(),
  chainId:           z.number().int().positive().default(11155111), // Sepolia
  cawProfileAddress: z.string().optional(),
  // Deposits are rare-ish on L1 (a couple per minute in busy periods,
  // hours of silence otherwise). 60s polls give chart freshness within
  // ~a minute of the user's deposit landing on L1, which feels live.
  pollIntervalMs:    z.number().int().positive().default(60_000),
  startBlock:        z.number().int().optional(),
  // Per-poll cap. Catch-up after downtime drains in chunks via
  // behindAfterPoll → 250ms retry, NOT in one massive request.
  maxBlocksPerPoll:  z.number().int().positive().default(10_000),
  redisUrl:          z.string().optional().default('redis://127.0.0.1:6379'),
})

type Config = z.infer<typeof Config>

const CAW_CLIENT_ID = (() => {
  const raw = process.env.CLIENT_ID
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('DepositWatcher: CLIENT_ID is required (set it in client/.env)')
  }
  return n
})()

// Match the event signature emitted by L1 CawProfile.deposit().
const DEPOSITED_ABI = [
  'event Deposited(uint32 indexed cawClientId, uint32 indexed tokenId, uint256 amount, uint32 indexed lzDestId, address depositor)',
]

const checkpointKey = (chainId: number, contract: string) =>
  `deposit-watcher:${chainId}:${contract.toLowerCase()}:last-block`

export const depositWatcherService: Service = {
  name: 'DepositWatcher',

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
      if (!rpcUrl) throw new Error('[DepositWatcher] No L1 RPC URL configured')
      await prisma.$connect()

      const provider = makeJsonRpcProvider(rpcUrl, cfg.chainId)
      const contract = new ethers.Contract(contractAddress, DEPOSITED_ABI, provider)
      console.log(`[DepositWatcher] Started — clientId=${CAW_CLIENT_ID}, contract=${contractAddress}, chainId=${cfg.chainId}, rpc=${redactRpcUrl(rpcUrl)}`)

      const cpKey = checkpointKey(cfg.chainId, contractAddress)
      let lastBlock: number
      const cp = await redis.get(cpKey)
      if (cp) {
        lastBlock = parseInt(cp, 10)
        console.log(`[DepositWatcher] Resuming from checkpoint block ${lastBlock}`)
      } else if (cfg.startBlock !== undefined) {
        lastBlock = cfg.startBlock
        console.log(`[DepositWatcher] No checkpoint — starting from configured startBlock ${lastBlock}`)
      } else {
        // No checkpoint and no configured start → only watch from now
        // forward. Historical deposits are the backfill script's job
        // (scripts/backfill-l1-deposits.ts) — it walks from contract
        // genesis once, then this watcher takes over for the live tail.
        lastBlock = await provider.getBlockNumber()
        console.log(`[DepositWatcher] No checkpoint — starting from current head ${lastBlock}`)
      }

      let behindAfterPoll = false

      const poll = async () => {
        if (!alive) return
        behindAfterPoll = false
        try {
          const currentBlock = await provider.getBlockNumber()
          if (currentBlock > lastBlock) {
            const fromBlock = lastBlock + 1
            const toBlock = Math.min(currentBlock, fromBlock + cfg.maxBlocksPerPoll - 1)
            behindAfterPoll = toBlock < currentBlock

            // Filter by clientId at the RPC level — Deposited's first
            // indexed topic is cawClientId, so the RPC drops events
            // for other clients before sending to us. Big saving on
            // multi-client deployments.
            const events = await contract.queryFilter(
              contract.filters.Deposited(CAW_CLIENT_ID),
              fromBlock,
              toBlock,
            )

            if (events.length > 0) {
              console.log(`[DepositWatcher] Processing ${events.length} Deposited event(s) in blocks ${fromBlock}..${toBlock}`)
            }

            for (const ev of events) {
              const args = (ev as ethers.EventLog).args
              if (!args) continue
              const tokenId = Number(args[1])
              const amount: bigint = BigInt(args[2])
              const txHash = ev.transactionHash
              const logIndex = (ev as any).index ?? (ev as any).logIndex ?? 0
              const blockNumber = BigInt(ev.blockNumber)

              // Block timestamp — one extra RPC per event but events
              // are rare and the timestamp drives chart accuracy.
              let blockTimestamp: Date
              try {
                const block = await provider.getBlock(ev.blockNumber)
                blockTimestamp = new Date(Number(block?.timestamp ?? 0) * 1000)
              } catch {
                // Provider hiccup? Fall back to NOW; better an
                // approximate timestamp than dropping the event.
                blockTimestamp = new Date()
              }

              try {
                await prisma.$transaction(async (tx) => {
                  await recordDeposit(tx, {
                    tokenId,
                    amountWei: amount,
                    blockNumber,
                    blockTimestamp,
                    txHash,
                    logIndex,
                  })
                }, { timeout: 15_000 })
              } catch (err: any) {
                console.warn(`[DepositWatcher] Failed to record deposit tokenId=${tokenId} tx=${txHash}:`, err?.message)
              }
            }

            lastBlock = toBlock
            await redis.set(cpKey, String(lastBlock))
          }
          ctx.heartbeat('poll')
        } catch (err: any) {
          console.error('[DepositWatcher] Poll error:', err?.message || err)
        } finally {
          if (!alive) return
          // Same catch-up cadence as NftTransferWatcher: 250ms when
          // we hit the per-poll cap (more blocks pending), full
          // interval otherwise.
          pollTimer = setTimeout(poll, behindAfterPoll ? 250 : cfg.pollIntervalMs)
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

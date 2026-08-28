// src/services/DepositWatcher/index.ts
//
// Watches CawProfile.Deposited(uint32 indexed cawNetworkId, uint32
// indexed tokenId, uint256 amount, uint32 indexed lzDestId, address
// depositor) events on L1 and writes a CawOwnershipSnapshot row per
// deposit (reason='DEPOSIT'). Closes the gap that the daily
// reconciler used to cover with imprecise NOW-timestamped guesses —
// deposits now show up on the activity chart with exact timing the
// moment the L1 tx is mined (typically faster than LayerZero settles
// the corresponding L2 update, which is fine: the chart only cares
// about WHEN the user committed CAW from L1).
//
// Filtered to the configured cawNetworkId so we don't index deposits
// from other CAW network deployments sharing the same L1 contract.
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
import { getL1HttpRpcUrl, getL1HttpRpcUrls, makeResilientHttpProvider, makeVerifiedJsonRpcProvider, redactRpcUrl, type ResilientProvider } from '../../utils/rpcProvider'
import { Service } from '../../Service'
import { prisma } from '../../prismaClient'
import { CAW_NAMES_ADDRESS } from '../../abi/addresses'
import { recordDeposit, applyDepositToMemory } from '../StakeLedger'
import { getNetworkId } from '../../utils/networkId'

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
  const raw = getNetworkId()
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('DepositWatcher: NETWORK_ID is required (set it in client/.env)')
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

      // Probe chainId ONCE at startup before trusting this RPC — DepositWatcher
      // feeds StakeLedger.recordDeposit (an authoritative in-memory ledger), so a
      // primary RPC on the wrong chain must never be silently trusted (audit
      // 2026-07-11 MEDIUM). The resilient handle below re-probes on every rebuild.
      await makeVerifiedJsonRpcProvider(rpcUrl, cfg.chainId)
      // Self-healing provider (2026-07-10 incident): a degraded L1 RPC rebuilds
      // itself instead of wedging the poll loop. Re-derived from rpc.get() each tick.
      const rpc: ResilientProvider = makeResilientHttpProvider(
        getL1HttpRpcUrls(cfg.l1RpcUrl), cfg.chainId, { label: 'DepositWatcher/L1' },
      )
      let provider = rpc.get()
      let contract = new ethers.Contract(contractAddress, DEPOSITED_ABI, provider)
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
      // Consecutive record-failure count. Drives an exponential backoff on the
      // retry cadence (see the anyFailed branch and the setTimeout in finally):
      // a permanently-failing deposit must not hot-loop queryFilter+getBlock+
      // findFirst at the catch-up rate. Reset to 0 on any fully-successful poll.
      let consecutiveFailures = 0
      // Cap for that backoff (15 min). Transient failures recover in 1-2 polls
      // (60s → 2m), while a permanently-failing deposit settles to one retry
      // per 15 min: 60s, 2m, 4m, 8m, 15m, 15m… — visible lag, not a hot loop.
      const DEPOSIT_FAILURE_BACKOFF_CAP_MS = 15 * 60_000

      const poll = async () => {
        if (!alive) return
        behindAfterPoll = false
        // Re-derive from the resilient handle each tick (auto-heal on RPC death).
        provider = rpc.get()
        contract = new ethers.Contract(contractAddress, DEPOSITED_ABI, provider)
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

            // Dedupe block-timestamp lookups: multiple deposits in the
            // same block previously fired separate provider.getBlock()
            // calls. Now we fetch each unique block once and reuse.
            const uniqueBlocks = Array.from(new Set(events.map(ev => ev.blockNumber)))
            const blockTsByNumber = new Map<number, Date>()
            await Promise.all(uniqueBlocks.map(async bn => {
              try {
                const block = await provider.getBlock(bn)
                // getBlock can resolve to null (rather than throw) on some
                // providers; Number(null?.timestamp ?? 0) * 1000 would silently
                // stamp 1970-01-01 into the snapshot the activity chart reads.
                // Treat null the same as the catch path below: approximate NOW.
                blockTsByNumber.set(bn, block ? new Date(Number(block.timestamp) * 1000) : new Date())
              } catch {
                // Provider hiccup → fall back to NOW; better an
                // approximate timestamp than dropping the event.
                blockTsByNumber.set(bn, new Date())
              }
            }))

            let anyFailed = false
            for (const ev of events) {
              const args = (ev as ethers.EventLog).args
              if (!args) continue
              const tokenId = Number(args[1])
              const amount: bigint = BigInt(args[2])
              const txHash = ev.transactionHash
              const logIndex = (ev as any).index ?? (ev as any).logIndex ?? 0
              const blockNumber = BigInt(ev.blockNumber)
              const blockTimestamp = blockTsByNumber.get(ev.blockNumber) ?? new Date()

              try {
                const result = await prisma.$transaction(async (tx) => {
                  return await recordDeposit(tx, {
                    tokenId,
                    amountWei: amount,
                    blockNumber,
                    blockTimestamp,
                    txHash,
                    logIndex,
                  })
                }, { timeout: 15_000 })
                // Post-Commit Mutation: Apply to in-memory ledger ONLY after
                // the DB transaction has successfully committed. This guarantees
                // atomicity between DB and memory, preventing double-counting
                // on checkpoint retries.
                if (result) {
                  await applyDepositToMemory(result.tokenId, result.amountWei, result.afterOwnership)
                }
              } catch (err: any) {
                // Swallow-and-advance was the bug: a failed deposit used to be
                // warned and then lastBlock advanced past it, so the block was
                // never re-read and the deposit was lost. Flag the failure so we
                // hold the checkpoint and re-read this range next poll instead.
                anyFailed = true
                console.warn(`[DepositWatcher] Failed to record deposit tokenId=${tokenId} tx=${txHash}:`, err?.message)
              }
            }

            if (anyFailed) {
              // Hold the checkpoint so the failed block(s) are re-read next
              // poll. recordDeposit is idempotent (skips on existing
              // txHash+logIndex+reason), so already-recorded deposits in this
              // range are no-ops on the retry. Count the failure so the retry
              // cadence backs off (see finally) rather than hot-looping at the
              // catch-up rate.
              consecutiveFailures++
            } else {
              consecutiveFailures = 0
              lastBlock = toBlock
              await redis.set(cpKey, String(lastBlock))
            }
          }
          ctx.heartbeat('poll')
        } catch (err: any) {
          console.error('[DepositWatcher] Poll error:', err?.message || err)
          rpc.reportError(err) // auto-heal on dead-connection errors
        } finally {
          if (!alive) return
          // Poll cadence, in priority order:
          //  1. a record failure held the checkpoint → back off exponentially
          //     from the configured interval (capped) so a permanently-failing
          //     deposit doesn't hot-loop and trip free-tier RPC rate limits.
          //  2. hit the per-poll cap with more blocks pending → 250ms catch-up
          //     (same as NftTransferWatcher).
          //  3. otherwise → the full configured interval.
          let nextPollMs: number
          if (consecutiveFailures > 0) {
            nextPollMs = Math.min(
              cfg.pollIntervalMs * 2 ** (consecutiveFailures - 1),
              DEPOSIT_FAILURE_BACKOFF_CAP_MS,
            )
          } else if (behindAfterPoll) {
            nextPollMs = 250
          } else {
            nextPollMs = cfg.pollIntervalMs
          }
          pollTimer = setTimeout(poll, nextPollMs)
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

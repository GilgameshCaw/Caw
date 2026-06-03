// src/services/SponsorRepayIndexer/index.ts
//
// Indexes four on-chain events into the SponsorRepay table:
//
//   L1  CawProfileMinter.SponsorRepaySet(tokenId, sponsorTokenId, repayAmount, depositAmount)
//       — written when the sponsor calls mintAndDepositSponsored; stored
//         before the L2 registration message lands.
//
//   L2  CawProfileLedger.SponsorRepayRegistered(tokenId, sponsorTokenId, repayAmount)
//       — L2 confirmation; sets originalRepayAmount + currentRepayAmount.
//
//   L2  CawProfileLedger.SponsorRepaySwept(tokenId, sponsorTokenId, swept, remaining)
//       — CawActions debits on each action; decrements currentRepayAmount.
//
//   L2  CawProfileLedger.SponsorRepayForgiven(tokenId, sponsorTokenId)
//       — sponsor forgives outstanding balance; zeroes currentRepayAmount.
//
// UPSERT semantics: L1 and L2 events can arrive in either order (L1 first is
// common; occasionally L2 catches up first if the L1 indexer lags). Both
// sides write their own fields; neither overwrites the other's.
//
// The service polls two chains independently, persisting per-contract
// checkpoints in Redis (same scheme as DepositWatcher). Fits alongside
// DepositWatcher in the L1 watcher family; L2 is an independent poll loop.

import 'dotenv/config'
import { z } from 'zod'
import { ethers } from 'ethers'
import Redis from 'ioredis'
import { makeJsonRpcProvider, getL1HttpRpcUrl, getL2HttpRpcUrl, redactRpcUrl } from '../../utils/rpcProvider'
import { Service } from '../../Service'
import { prisma } from '../../prismaClient'

// ──────────────────────────────────────────────────────────────────────────────
// ABI fragments — string form so we don't need to regenerate generated.ts
// ──────────────────────────────────────────────────────────────────────────────

const MINTER_ABI = [
  'event SponsorRepaySet(uint32 indexed tokenId, uint32 sponsorTokenId, uint256 repayAmount, uint256 depositAmount)',
] as const

const LEDGER_ABI = [
  'event SponsorRepayRegistered(uint32 indexed tokenId, uint32 sponsorTokenId, uint256 repayAmount)',
  'event SponsorRepaySwept(uint32 indexed tokenId, uint32 sponsorTokenId, uint256 swept, uint256 remaining)',
  'event SponsorRepayForgiven(uint32 indexed tokenId, uint32 sponsorTokenId)',
] as const

// ──────────────────────────────────────────────────────────────────────────────
// Config schema (zod)
// ──────────────────────────────────────────────────────────────────────────────

const Config = z.object({
  // L1 Sepolia — CawProfileMinter lives here
  l1RpcUrl:        z.string().optional(),
  l1ChainId:       z.number().int().positive().default(11155111), // Sepolia
  minterAddress:   z.string().optional(),  // CAW_NAMES_MINTER_ADDRESS

  // L2 Base Sepolia — CawProfileLedger lives here
  l2RpcUrl:        z.string().optional(),
  l2ChainId:       z.number().int().positive().default(84532),    // Base Sepolia
  ledgerAddress:   z.string().optional(),  // CAW_NAMES_L2_ADDRESS

  pollIntervalMs:  z.number().int().positive().default(60_000),
  maxBlocksPerPoll: z.number().int().positive().default(10_000),
  redisUrl:        z.string().optional().default('redis://127.0.0.1:6379'),
  // Optional block to start L1/L2 scan from (avoids scanning from genesis).
  l1StartBlock:    z.number().int().optional(),
  l2StartBlock:    z.number().int().optional(),
})

type Config = z.infer<typeof Config>

// ──────────────────────────────────────────────────────────────────────────────
// Redis checkpoint helpers
// ──────────────────────────────────────────────────────────────────────────────

const cpKey = (chain: string, contract: string) =>
  `sponsor-repay-indexer:${chain}:${contract.toLowerCase()}:last-block`

async function loadCheckpoint(redis: Redis, key: string, fallback: number): Promise<number> {
  const stored = await redis.get(key)
  if (stored) return parseInt(stored, 10)
  return fallback
}

async function saveCheckpoint(redis: Redis, key: string, block: number): Promise<void> {
  await redis.set(key, String(block))
}

// ──────────────────────────────────────────────────────────────────────────────
// DB handlers — two-tx split NOT needed here: each is an independent atomic
// row (no cross-table derived side-effects that could silently drop). Mirror
// the fact row only.
// ──────────────────────────────────────────────────────────────────────────────

async function handleSponsorRepaySet(args: ethers.Result, txHash: string): Promise<void> {
  const tokenId       = Number(args[0])
  const sponsorTokenId = Number(args[1])
  // repayAmount is args[2] but we don't store it here — that's L2's job via
  // SponsorRepayRegistered. We only store the L1-side audit fields.
  const depositAmount = String(BigInt(args[3]))

  try {
    await prisma.sponsorRepay.upsert({
      where:  { tokenId },
      create: {
        tokenId,
        sponsorTokenId,
        // These will be filled in by SponsorRepayRegistered; put zeros so
        // the NOT NULL constraint is satisfied if L2 hasn't landed yet.
        originalRepayAmount: '0',
        currentRepayAmount:  '0',
        sponsoredDepositAmount: depositAmount,
        txHashSet: txHash,
      },
      update: {
        // Only overwrite L1-side fields; don't trample L2 fields that may
        // have already been written by SponsorRepayRegistered.
        sponsorTokenId,
        sponsoredDepositAmount: depositAmount,
        txHashSet: txHash,
      },
    })
    console.log(`[SponsorRepayIndexer:L1] SponsorRepaySet tokenId=${tokenId} sponsor=${sponsorTokenId} deposit=${depositAmount}`)
  } catch (err: any) {
    console.error(`[SponsorRepayIndexer:L1] Failed to upsert for tokenId=${tokenId}:`, err?.message)
  }
}

async function handleSponsorRepayRegistered(args: ethers.Result, txHash: string): Promise<void> {
  const tokenId        = Number(args[0])
  const sponsorTokenId = Number(args[1])
  const repayAmount    = String(BigInt(args[2]))

  try {
    await prisma.sponsorRepay.upsert({
      where:  { tokenId },
      create: {
        tokenId,
        sponsorTokenId,
        originalRepayAmount: repayAmount,
        currentRepayAmount:  repayAmount,
        registeredAt: new Date(),
        txHashRegistered: txHash,
      },
      update: {
        // Fill in the L2 fields; don't overwrite L1 fields (txHashSet,
        // sponsoredDepositAmount) if they were already set by the L1 event.
        sponsorTokenId,
        originalRepayAmount: repayAmount,
        currentRepayAmount:  repayAmount,
        registeredAt: new Date(),
        txHashRegistered: txHash,
      },
    })
    console.log(`[SponsorRepayIndexer:L2] SponsorRepayRegistered tokenId=${tokenId} sponsor=${sponsorTokenId} repay=${repayAmount}`)
  } catch (err: any) {
    console.error(`[SponsorRepayIndexer:L2] Failed to upsert Registered for tokenId=${tokenId}:`, err?.message)
  }
}

async function handleSponsorRepaySwept(args: ethers.Result): Promise<void> {
  const tokenId   = Number(args[0])
  const swept     = String(BigInt(args[2]))
  const remaining = String(BigInt(args[3]))

  try {
    await prisma.sponsorRepay.update({
      where: { tokenId },
      data: {
        currentRepayAmount: remaining,
        lastSweepAmount:    swept,
        lastSweepAt:        new Date(),
      },
    })
    console.log(`[SponsorRepayIndexer:L2] SponsorRepaySwept tokenId=${tokenId} swept=${swept} remaining=${remaining}`)
  } catch (err: any) {
    // Row may not exist if SponsorRepayRegistered hasn't been indexed yet —
    // log and move on; next Registered event will create it with current state.
    console.warn(`[SponsorRepayIndexer:L2] Failed to update Swept for tokenId=${tokenId} (row may not exist yet):`, err?.message)
  }
}

async function handleSponsorRepayForgiven(args: ethers.Result): Promise<void> {
  const tokenId = Number(args[0])

  try {
    await prisma.sponsorRepay.update({
      where: { tokenId },
      data: {
        forgivenAt:        new Date(),
        currentRepayAmount: '0',
      },
    })
    console.log(`[SponsorRepayIndexer:L2] SponsorRepayForgiven tokenId=${tokenId}`)
  } catch (err: any) {
    console.warn(`[SponsorRepayIndexer:L2] Failed to update Forgiven for tokenId=${tokenId}:`, err?.message)
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Poll loop factory — shared logic for L1 and L2 sides
// ──────────────────────────────────────────────────────────────────────────────

function makePollLoop(opts: {
  label:       string
  provider:    ethers.JsonRpcProvider
  contract:    ethers.Contract
  redis:       Redis
  cpKey:       string
  startBlock:  number
  maxBlocks:   number
  pollMs:      number
  heartbeat:   (name?: string) => void
  processEvents: (events: ethers.EventLog[]) => Promise<void>
  alive:       () => boolean
}): { stop: () => void; start: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastBlock = opts.startBlock

  const poll = async () => {
    if (!opts.alive()) return
    try {
      const current = await opts.provider.getBlockNumber()
      if (current > lastBlock) {
        const from = lastBlock + 1
        const to   = Math.min(current, from + opts.maxBlocks - 1)

        const allFilters = opts.contract.filters
        const eventNames = Object.keys(allFilters).filter(k => typeof allFilters[k] === 'function')

        // Fetch all event types in parallel for this chunk
        const resultArrays = await Promise.all(
          eventNames.map(name =>
            (opts.contract.queryFilter(opts.contract.filters[name](), from, to) as Promise<ethers.EventLog[]>)
              .catch((err: any) => {
                console.warn(`[${opts.label}] queryFilter ${name} failed:`, err?.message?.slice(0, 120))
                return [] as ethers.EventLog[]
              })
          )
        )

        // Merge and sort by block + logIndex for deterministic processing
        const merged = resultArrays.flat().sort((a, b) => {
          if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber
          return (a.index ?? 0) - (b.index ?? 0)
        })

        if (merged.length > 0) {
          console.log(`[${opts.label}] Processing ${merged.length} event(s) in blocks ${from}..${to}`)
          await opts.processEvents(merged)
        }

        lastBlock = to
        await saveCheckpoint(opts.redis, opts.cpKey, to)
      }
      opts.heartbeat(opts.label)
    } catch (err: any) {
      console.error(`[${opts.label}] Poll error:`, err?.message || err)
    } finally {
      if (!opts.alive()) return
      const behind = lastBlock < (await opts.provider.getBlockNumber().catch(() => lastBlock))
      timer = setTimeout(poll, behind ? 250 : opts.pollMs)
    }
  }

  return {
    start: () => { poll() },
    stop:  () => { if (timer) clearTimeout(timer) },
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Service export
// ──────────────────────────────────────────────────────────────────────────────

export const sponsorRepayIndexerService: Service = {
  name: 'SponsorRepayIndexer',

  validateConfig(cfg: unknown) {
    const result = Config.safeParse(cfg)
    return result.success
      ? []
      : result.error.errors.map(e => new Error(`ZodError: ${e.message}`))
  },

  start(configParam: unknown, ctx: import('../../Service').HeartbeatContext) {
    const cfg = Config.parse(configParam)

    ctx.declareLoop('SponsorRepayIndexer:L1', Math.max(cfg.pollIntervalMs * 3, 180_000))
    ctx.declareLoop('SponsorRepayIndexer:L2', Math.max(cfg.pollIntervalMs * 3, 180_000))

    const redis = new Redis(cfg.redisUrl)

    let isAlive = true
    let l1Loop: ReturnType<typeof makePollLoop> | null = null
    let l2Loop: ReturnType<typeof makePollLoop> | null = null

    const started = (async () => {
      await prisma.$connect()

      // ── L1: CawProfileMinter — SponsorRepaySet ──────────────────────────
      const l1RpcUrl = getL1HttpRpcUrl(cfg.l1RpcUrl)
      if (l1RpcUrl && cfg.minterAddress) {
        const l1Provider = makeJsonRpcProvider(l1RpcUrl, cfg.l1ChainId)
        const minterContract = new ethers.Contract(cfg.minterAddress, MINTER_ABI as any, l1Provider)

        const l1CpKey = cpKey(String(cfg.l1ChainId), cfg.minterAddress)
        const currentL1 = await l1Provider.getBlockNumber().catch(() => 0)
        const l1Start = await loadCheckpoint(redis, l1CpKey, cfg.l1StartBlock ?? currentL1)

        console.log(`[SponsorRepayIndexer:L1] Starting — minter=${cfg.minterAddress} chainId=${cfg.l1ChainId} fromBlock=${l1Start}`)

        l1Loop = makePollLoop({
          label:    'SponsorRepayIndexer:L1',
          provider: l1Provider,
          contract: minterContract,
          redis,
          cpKey:    l1CpKey,
          startBlock: l1Start,
          maxBlocks: cfg.maxBlocksPerPoll,
          pollMs:   cfg.pollIntervalMs,
          heartbeat: ctx.heartbeat,
          alive:    () => isAlive,
          processEvents: async (events) => {
            for (const ev of events) {
              if (!ev.args) continue
              if (ev.eventName === 'SponsorRepaySet') {
                await handleSponsorRepaySet(ev.args, ev.transactionHash)
              }
            }
          },
        })
        l1Loop.start()
      } else {
        console.log('[SponsorRepayIndexer:L1] Skipping — no L1 RPC or minterAddress configured')
      }

      // ── L2: CawProfileLedger — Registered / Swept / Forgiven ───────────
      const l2RpcUrl = getL2HttpRpcUrl(cfg.l2RpcUrl)
      if (l2RpcUrl && cfg.ledgerAddress) {
        const l2Provider = makeJsonRpcProvider(l2RpcUrl, cfg.l2ChainId)
        const ledgerContract = new ethers.Contract(cfg.ledgerAddress, LEDGER_ABI as any, l2Provider)

        const l2CpKey = cpKey(String(cfg.l2ChainId), cfg.ledgerAddress)
        const currentL2 = await l2Provider.getBlockNumber().catch(() => 0)
        const l2Start = await loadCheckpoint(redis, l2CpKey, cfg.l2StartBlock ?? currentL2)

        console.log(`[SponsorRepayIndexer:L2] Starting — ledger=${cfg.ledgerAddress} chainId=${cfg.l2ChainId} fromBlock=${l2Start}`)

        l2Loop = makePollLoop({
          label:    'SponsorRepayIndexer:L2',
          provider: l2Provider,
          contract: ledgerContract,
          redis,
          cpKey:    l2CpKey,
          startBlock: l2Start,
          maxBlocks: cfg.maxBlocksPerPoll,
          pollMs:   cfg.pollIntervalMs,
          heartbeat: ctx.heartbeat,
          alive:    () => isAlive,
          processEvents: async (events) => {
            for (const ev of events) {
              if (!ev.args) continue
              switch (ev.eventName) {
                case 'SponsorRepayRegistered':
                  await handleSponsorRepayRegistered(ev.args, ev.transactionHash)
                  break
                case 'SponsorRepaySwept':
                  await handleSponsorRepaySwept(ev.args)
                  break
                case 'SponsorRepayForgiven':
                  await handleSponsorRepayForgiven(ev.args)
                  break
              }
            }
          },
        })
        l2Loop.start()
      } else {
        console.log('[SponsorRepayIndexer:L2] Skipping — no L2 RPC or ledgerAddress configured')
      }
    })()

    return {
      started,
      async stop() {
        isAlive = false
        l1Loop?.stop()
        l2Loop?.stop()
        await redis.quit()
        await prisma.$disconnect()
      },
      stats: async () => {
        const count = await prisma.sponsorRepay.count()
        return `SponsorRepay rows: ${count}`
      },
    }
  },
}

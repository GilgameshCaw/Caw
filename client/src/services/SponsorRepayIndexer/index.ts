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
import { CAW_NAMES_MINTER_ADDRESS, CAW_NAMES_L2_ADDRESS } from '../../abi/addresses'
import { Service } from '../../Service'
import { prisma } from '../../prismaClient'

// Allow tests to inject a mock Prisma client (same pattern as validateSponsorCode).
let _prismaOverride: typeof prisma | null = null
export function _setPrismaForTest(p: typeof prisma | null): void {
  _prismaOverride = p
}
function getPrisma(): typeof prisma {
  return _prismaOverride ?? prisma
}

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
//
// A failed DB write is rethrown, not swallowed: processEvents then rejects and
// the poll loop holds its cursor, so the window is re-read and replayed in
// order on the next tick (same as DepositWatcher). Swallowing it let the
// cursor advance past an event that was never written, losing it for good.
// ──────────────────────────────────────────────────────────────────────────────

async function handleSponsorRepaySet(args: ethers.Result, txHash: string): Promise<void> {
  const tokenId       = Number(args[0])
  const sponsorTokenId = Number(args[1])
  // repayAmount is args[2] but we don't store it here — that's L2's job via
  // SponsorRepayRegistered. We only store the L1-side audit fields.
  const depositAmount = String(BigInt(args[3]))

  try {
    await getPrisma().sponsorRepay.upsert({
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
    throw err
  }
}

async function handleSponsorRepayRegistered(args: ethers.Result, txHash: string): Promise<void> {
  const tokenId        = Number(args[0])
  const sponsorTokenId = Number(args[1])
  const repayAmount    = String(BigInt(args[2]))

  try {
    await getPrisma().sponsorRepay.upsert({
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
    throw err
  }
}

async function handleSponsorRepaySwept(args: ethers.Result): Promise<void> {
  const tokenId   = Number(args[0])
  const swept     = String(BigInt(args[2]))
  const remaining = String(BigInt(args[3]))

  try {
    await getPrisma().sponsorRepay.update({
      where: { tokenId },
      data: {
        currentRepayAmount: remaining,
        lastSweepAmount:    swept,
        lastSweepAt:        new Date(),
      },
    })
    console.log(`[SponsorRepayIndexer:L2] SponsorRepaySwept tokenId=${tokenId} swept=${swept} remaining=${remaining}`)
  } catch (err: any) {
    // P2025 = no row for this tokenId (its SponsorRepayRegistered was never
    // indexed, e.g. it predates the start block). Re-reading the window won't
    // create the row, so log and move on rather than stall the cursor.
    if (err?.code === 'P2025') {
      console.warn(`[SponsorRepayIndexer:L2] Skipping Swept for tokenId=${tokenId}: no SponsorRepay row`)
      return
    }
    console.error(`[SponsorRepayIndexer:L2] Failed to update Swept for tokenId=${tokenId}:`, err?.message)
    throw err
  }
}

async function handleSponsorRepayForgiven(args: ethers.Result): Promise<void> {
  const tokenId = Number(args[0])

  try {
    await getPrisma().sponsorRepay.update({
      where: { tokenId },
      data: {
        forgivenAt:        new Date(),
        currentRepayAmount: '0',
      },
    })
    console.log(`[SponsorRepayIndexer:L2] SponsorRepayForgiven tokenId=${tokenId}`)
  } catch (err: any) {
    // P2025 = no row to forgive (see Swept above): skip, don't stall.
    if (err?.code === 'P2025') {
      console.warn(`[SponsorRepayIndexer:L2] Skipping Forgiven for tokenId=${tokenId}: no SponsorRepay row`)
      return
    }
    console.error(`[SponsorRepayIndexer:L2] Failed to update Forgiven for tokenId=${tokenId}:`, err?.message)
    throw err
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Poll loop factory — shared logic for L1 and L2 sides
// ──────────────────────────────────────────────────────────────────────────────

// Cap for the retry backoff after failed polls: pollMs, 2x, 4x, … instead
// of re-polling every 250ms while a held cursor keeps the loop "behind".
// Each wait also stays under the loop's watchdog timeout (backoffCapMs in
// start()), so a loop that is only backing off is not restarted as dead.
const FAILURE_BACKOFF_CAP_MS = 15 * 60_000

// Watchdog timeout for each poll loop (declareLoop).
const loopTimeoutMs = (pollMs: number) => Math.max(pollMs * 3, 180_000)

// Event names to poll, from the ABI. Object.keys(contract.filters) is [] for
// an ethers v6 Contract (filters is a Proxy), which left the loop with no
// events to fetch while it still advanced the checkpoint.
function eventNamesOf(contract: ethers.Contract): string[] {
  return contract.interface.fragments
    .filter((f): f is ethers.EventFragment => f.type === 'event')
    .map(f => f.name)
}

function makePollLoop(opts: {
  label:       string
  provider:    ethers.JsonRpcProvider
  contract:    ethers.Contract
  redis:       Redis
  cpKey:       string
  startBlock:  number
  maxBlocks:   number
  pollMs:      number
  backoffCapMs: number
  heartbeat:   (name?: string) => void
  heartbeatDegraded: (name?: string, reason?: string) => void
  processEvents: (events: ethers.EventLog[]) => Promise<void>
  alive:       () => boolean
}): { stop: () => void; start: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastBlock = opts.startBlock
  let consecutiveFailures = 0

  const poll = async () => {
    if (!opts.alive()) return
    try {
      const current = await opts.provider.getBlockNumber()
      if (current > lastBlock) {
        const from = lastBlock + 1
        const to   = Math.min(current, from + opts.maxBlocks - 1)

        const eventNames = eventNamesOf(opts.contract)

        // Fetch all event types in parallel for this chunk. Deliberately NO
        // per-name .catch(() => []) here: swallowing a queryFilter failure to
        // an empty array lets the cursor advance (lastBlock = to /
        // saveCheckpoint(to) below) past a window whose events were never
        // fetched, silently and permanently dropping any events in it. Letting
        // Promise.all reject instead routes to the outer catch, which leaves
        // lastBlock untouched so the same from..to window is retried on the
        // next tick. processEvents (idempotent per-tokenId upsert/update) runs
        // only after a fully successful fetch, so a retry never double-processes.
        // processEvents itself rejects when a handler's DB write fails, which
        // takes the same route: the window is re-read and replayed in order.
        const resultArrays = await Promise.all(
          eventNames.map(name =>
            opts.contract.queryFilter(opts.contract.filters[name](), from, to) as Promise<ethers.EventLog[]>
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

        // Move the cursor only once the checkpoint is saved. If the save
        // fails, the window is re-read and the save retried next poll, even
        // when the chain head hasn't moved.
        await saveCheckpoint(opts.redis, opts.cpKey, to)
        lastBlock = to
      }
      consecutiveFailures = 0
      opts.heartbeat(opts.label)
    } catch (err: any) {
      consecutiveFailures++
      console.error(`[${opts.label}] Poll error:`, err?.message || err)
      // The loop ran but could not advance. Without a heartbeat here the
      // watchdog restarted the service mid-backoff.
      opts.heartbeatDegraded(opts.label, `poll failed ${consecutiveFailures}x: ${String(err?.message || err).slice(0, 120)}`)
    } finally {
      if (!opts.alive()) return
      let nextMs: number
      if (consecutiveFailures > 0) {
        nextMs = Math.min(opts.pollMs * 2 ** (consecutiveFailures - 1), opts.backoffCapMs)
      } else {
        const behind = lastBlock < (await opts.provider.getBlockNumber().catch(() => lastBlock))
        nextMs = behind ? 250 : opts.pollMs
      }
      timer = setTimeout(poll, nextMs)
    }
  }

  return {
    start: () => { poll() },
    stop:  () => { if (timer) clearTimeout(timer) },
  }
}

export const _forTests = {
  MINTER_ABI,
  LEDGER_ABI,
  eventNamesOf,
  makePollLoop,
  handleSponsorRepaySet,
  handleSponsorRepayRegistered,
  handleSponsorRepaySwept,
  handleSponsorRepayForgiven,
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

    // Each loop is declared only when it runs: a declared loop that never
    // heartbeats (no RPC or address for that chain) restarts the service.
    const timeoutMs = loopTimeoutMs(cfg.pollIntervalMs)
    // Leave one poll interval of the timeout for the poll itself.
    const backoffCapMs = Math.min(FAILURE_BACKOFF_CAP_MS, timeoutMs - cfg.pollIntervalMs)

    const redis = new Redis(cfg.redisUrl)

    let isAlive = true
    let l1Loop: ReturnType<typeof makePollLoop> | null = null
    let l2Loop: ReturnType<typeof makePollLoop> | null = null

    const started = (async () => {
      await prisma.$connect()

      // ── L1: CawProfileMinter — SponsorRepaySet ──────────────────────────
      const l1RpcUrl = getL1HttpRpcUrl(cfg.l1RpcUrl)
      const minterAddress = cfg.minterAddress || CAW_NAMES_MINTER_ADDRESS
      if (l1RpcUrl && minterAddress) {
        const l1Provider = makeJsonRpcProvider(l1RpcUrl, cfg.l1ChainId)
        const minterContract = new ethers.Contract(minterAddress, MINTER_ABI as any, l1Provider)

        const l1CpKey = cpKey(String(cfg.l1ChainId), minterAddress)
        const currentL1 = await l1Provider.getBlockNumber().catch(() => 0)
        const l1Start = await loadCheckpoint(redis, l1CpKey, cfg.l1StartBlock ?? currentL1)

        console.log(`[SponsorRepayIndexer:L1] Starting — minter=${minterAddress} chainId=${cfg.l1ChainId} fromBlock=${l1Start}`)

        ctx.declareLoop('SponsorRepayIndexer:L1', timeoutMs)
        l1Loop = makePollLoop({
          label:    'SponsorRepayIndexer:L1',
          provider: l1Provider,
          contract: minterContract,
          redis,
          cpKey:    l1CpKey,
          startBlock: l1Start,
          maxBlocks: cfg.maxBlocksPerPoll,
          pollMs:   cfg.pollIntervalMs,
          backoffCapMs,
          heartbeat: ctx.heartbeat,
          heartbeatDegraded: ctx.heartbeatDegraded,
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
      const ledgerAddress = cfg.ledgerAddress || CAW_NAMES_L2_ADDRESS
      if (l2RpcUrl && ledgerAddress) {
        const l2Provider = makeJsonRpcProvider(l2RpcUrl, cfg.l2ChainId)
        const ledgerContract = new ethers.Contract(ledgerAddress, LEDGER_ABI as any, l2Provider)

        const l2CpKey = cpKey(String(cfg.l2ChainId), ledgerAddress)
        const currentL2 = await l2Provider.getBlockNumber().catch(() => 0)
        const l2Start = await loadCheckpoint(redis, l2CpKey, cfg.l2StartBlock ?? currentL2)

        console.log(`[SponsorRepayIndexer:L2] Starting — ledger=${ledgerAddress} chainId=${cfg.l2ChainId} fromBlock=${l2Start}`)

        ctx.declareLoop('SponsorRepayIndexer:L2', timeoutMs)
        l2Loop = makePollLoop({
          label:    'SponsorRepayIndexer:L2',
          provider: l2Provider,
          contract: ledgerContract,
          redis,
          cpKey:    l2CpKey,
          startBlock: l2Start,
          maxBlocks: cfg.maxBlocksPerPoll,
          pollMs:   cfg.pollIntervalMs,
          backoffCapMs,
          heartbeat: ctx.heartbeat,
          heartbeatDegraded: ctx.heartbeatDegraded,
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

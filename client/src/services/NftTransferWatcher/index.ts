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
import { makeJsonRpcProvider, getL1HttpRpcUrl, redactRpcUrl } from '../../utils/rpcProvider'
import { Service } from '../../Service'
import { prisma } from '../../prismaClient'
import { CAW_NAMES_ADDRESS } from '../../abi/addresses'
import { findOrCreateUser, StaleTokenError } from '../UserService'
import { pruneTokenIdFromAllSessions } from '../../api/sessionStore'

const Config = z.object({
  l1RpcUrl:            z.string().optional(),
  chainId:             z.number().int().positive().default(11155111), // Sepolia today, mainnet later
  cawProfileAddress:   z.string().optional(),
  // 60s default — Transfer events on the L1 Profile NFT are rare (a mint or
  // a marketplace sale every few minutes in the busy case, hours otherwise).
  // Shorter intervals just burn eth_getLogs credits to find empty windows.
  pollIntervalMs:      z.number().int().positive().default(60_000),
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

// ERC-721 Transfer event + the CawProfile-specific nextId() view that
// tells us the highest tokenId that's ever been minted (so we can
// detect gaps left by Mint events that happened before this watcher
// started observing).
const TRANSFER_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'function nextId() view returns (uint32)',
]

// Throttle the historical backfill so we don't blast the L1 RPC. Each
// missing tokenId is one ownerOf() + one usernameById() call inside
// findOrCreateUser, so a 100-token gap = ~200 RPC calls. At 10/sec we
// finish in ~10s — still bounded, doesn't trip free-tier rate limits.
const BACKFILL_BATCH_SIZE = 10
const BACKFILL_BATCH_DELAY_MS = 1000

// Re-check for gaps every N poll ticks (in addition to the once-on-start
// pass). Catches drift from poll failures we didn't notice. With the
// default 60s poll cadence, 60 ticks = 1 hour.
const BACKFILL_RECHECK_EVERY_N_POLLS = 60

// Redis key storing the last block we've processed. Interim home until the
// per-client checkpoint table lands as part of #4 in the scalability plan.
const checkpointKey = (chainId: number, contract: string) =>
  `nft-transfer-watcher:${chainId}:${contract.toLowerCase()}:last-block`

/**
 * Find every tokenId in [1..nextId-1] that's missing from the User table
 * and create the row by calling findOrCreateUser (which reads the L1
 * metadata via ownerOf + usernameById and inserts).
 *
 * Why this exists: the watcher only sees Transfer events from its
 * checkpoint forward. Any token minted *before* the watcher first
 * started (or before the checkpoint was set) never had its Mint event
 * observed and so the User row was never created. The original install
 * pulled from a chain that already had ~95 historical mints, so the API
 * returns 202 "ownership not yet indexed" forever for those tokens.
 *
 * Idempotent: re-runs are no-ops because rows already exist (cached by
 * findOrCreateUser). Throttled to BACKFILL_BATCH_SIZE per
 * BACKFILL_BATCH_DELAY_MS to avoid blasting the L1 RPC.
 *
 * Burned tokens (ownerOf reverts) are caught by findOrCreateUser as
 * StaleTokenError; we log + skip them.
 */
async function backfillMissingMints(contract: ethers.Contract): Promise<void> {
  let nextId: number
  try {
    nextId = Number(await contract.nextId())
  } catch (err: any) {
    console.warn('[NftTransferWatcher] backfill: nextId() call failed, skipping:', err?.message)
    return
  }
  const maxMintedId = nextId - 1
  if (maxMintedId < 1) return

  const known = await prisma.user.findMany({
    where:  { tokenId: { gte: 1, lte: maxMintedId } },
    select: { tokenId: true },
  })
  const knownSet = new Set(known.map(u => u.tokenId))
  const missing: number[] = []
  for (let id = 1; id <= maxMintedId; id++) {
    if (!knownSet.has(id)) missing.push(id)
  }
  if (missing.length === 0) return

  console.log(`[NftTransferWatcher] backfill: ${missing.length} missing User row(s) in [1..${maxMintedId}]; filling at ${BACKFILL_BATCH_SIZE}/${BACKFILL_BATCH_DELAY_MS}ms`)

  let filled = 0
  let burned = 0
  for (let i = 0; i < missing.length; i += BACKFILL_BATCH_SIZE) {
    const batch = missing.slice(i, i + BACKFILL_BATCH_SIZE)
    await Promise.all(batch.map(async tokenId => {
      try {
        await findOrCreateUser(tokenId)
        filled++
      } catch (err: any) {
        if (err instanceof StaleTokenError) {
          burned++  // Burned or never minted on this contract.
          return
        }
        console.warn(`[NftTransferWatcher] backfill tokenId=${tokenId} failed:`, err?.message)
      }
    }))
    if (i + BACKFILL_BATCH_SIZE < missing.length) {
      await new Promise(r => setTimeout(r, BACKFILL_BATCH_DELAY_MS))
    }
  }
  console.log(`[NftTransferWatcher] backfill: filled ${filled}, skipped ${burned} burned/missing, of ${missing.length} candidates`)
}

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
      console.log(`[NftTransferWatcher] Started — contract=${contractAddress}, chainId=${cfg.chainId}, rpc=${redactRpcUrl(rpcUrl)}`)

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

      // Set true at the end of a poll if more blocks remain right now (we hit
      // the per-poll cap). Drives the catch-up scheduling in `finally`.
      let behindAfterPoll = false

      // Tick counter so we can run the gap-backfill periodically (every
      // BACKFILL_RECHECK_EVERY_N_POLLS ticks) in addition to the
      // once-on-start pass kicked off below.
      let pollTick = 0

      // Kick off the once-on-start backfill async — don't block the first
      // poll behind it. The poll loop processes new Transfer events
      // independently; both writers race to insert the same rows for
      // tokens minted right around startup, but findOrCreateUser uses
      // an upsert + per-tokenId cache so both paths are idempotent.
      backfillMissingMints(contract).catch(err => {
        console.warn('[NftTransferWatcher] startup backfill failed:', err?.message || err)
      })

      const poll = async () => {
        if (!alive) return
        behindAfterPoll = false
        try {
          const currentBlock = await provider.getBlockNumber()
          if (currentBlock > lastBlock) {
            const fromBlock = lastBlock + 1
            const toBlock = Math.min(currentBlock, fromBlock + cfg.maxBlocksPerPoll - 1)
            behindAfterPoll = toBlock < currentBlock

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
                    // For fresh mints, start at onboardingStep=0 so the
                    // operator goes through the welcome stepper. Without
                    // this, findOrCreateUser defaults to step=5 (complete)
                    // and the watcher races ahead of /api/users/ensure to
                    // create the row, which then makes WelcomePage redirect
                    // straight to /home. Late-join transfers stay at the
                    // default — the user is established, no welcome flow.
                    await findOrCreateUser(tokenId, isMint ? { onboardingStep: 0 } : {})
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
                    // Prune stale session authorizations: any session that
                    // signed in as the previous owner still has this tokenId
                    // in authorizedTokenIds and would otherwise be allowed
                    // through token-scoped requireAuth checks. Failures
                    // here are non-fatal — the per-route owner re-check
                    // (where present) is the second line of defense.
                    try {
                      const n = await pruneTokenIdFromAllSessions(tokenId)
                      if (n > 0) console.log(`[NftTransferWatcher] Pruned tokenId=${tokenId} from ${n} stale session(s)`)
                    } catch (err: any) {
                      console.warn(`[NftTransferWatcher] Session prune failed for tokenId=${tokenId}:`, err?.message)
                    }
                  }
                } else if (user.address.toLowerCase() !== toAddr) {
                  console.log(`[NftTransferWatcher] tokenId=${tokenId} transferred: ${user.address} → ${toAddr}`)
                  await prisma.user.update({
                    where: { tokenId },
                    data: { address: toAddr },
                  })
                  try {
                    const n = await pruneTokenIdFromAllSessions(tokenId)
                    if (n > 0) console.log(`[NftTransferWatcher] Pruned tokenId=${tokenId} from ${n} stale session(s)`)
                  } catch (err: any) {
                    console.warn(`[NftTransferWatcher] Session prune failed for tokenId=${tokenId}:`, err?.message)
                  }
                }
              } catch (err: any) {
                console.warn(`[NftTransferWatcher] Failed to apply transfer for tokenId=${tokenId}:`, err?.message)
              }
            }

            lastBlock = toBlock
            await redis.set(cpKey, String(lastBlock))
          }
          ctx.heartbeat('poll')

          // Periodic gap re-check. Cheap when there are no gaps (one
          // nextId() RPC + one indexed count from the User table); only
          // does the per-token loop if drift is detected. Fire-and-
          // forget so a stuck backfill doesn't block the next poll.
          pollTick++
          if (pollTick % BACKFILL_RECHECK_EVERY_N_POLLS === 0) {
            backfillMissingMints(contract).catch(err => {
              console.warn('[NftTransferWatcher] periodic backfill failed:', err?.message || err)
            })
          }
        } catch (err: any) {
          console.error('[NftTransferWatcher] Poll error:', err?.message || err)
        } finally {
          // Drain quickly when behind: if the last poll hit the per-tick cap,
          // more blocks remain right now — schedule the next pass on a short
          // delay instead of sleeping the full interval. Why: a multi-day
          // downtime leaves the checkpoint tens of thousands of blocks behind,
          // and at 10k blocks per 60s tick we'd take ~5 min to catch up —
          // long enough for a marketplace buy to stay invisible to the
          // indexer after the user has refreshed the page.
          if (!alive) return
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

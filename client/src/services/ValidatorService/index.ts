// src/services/ValidatorService/index.ts

import { z } from 'zod'
import 'dotenv/config'
import { Service } from '../../Service'
import { prisma }  from '../../prismaClient'
import getActionType from '../../abi/getActionType'
import { cawActionsAbi } from '../../abi/generated'
import { CAW_ACTIONS_ADDRESS, CAW_ADDRESS, WETH_ADDRESS, CAW_ACTIONS_ARCHIVE_ADDRESS, CAW_CHALLENGE_RELAY_ADDRESS } from '../../abi/addresses'
import { WebSocketProvider, JsonRpcProvider, Contract, Wallet, Interface, keccak256, solidityPacked, AbiCoder } from 'ethers'
import { packActions, packSignatures, bytesToHex, getPackedActionSlices, unpackActions } from '../../utils/packActions'
import { buildCheckpointMerkleTree } from '../../utils/checkpointMerkle'
import { tryClaimChallengeLock, releaseChallengeLock } from '../../utils/challengeLock'
import { foldCheckpointHashes } from '../../utils/foldCheckpointHashes'
import { makeJsonRpcProvider, makeWebSocketProvider, getL2HttpRpcUrl } from '../../utils/rpcProvider'
import { cawToEthCached, isPriceFresh } from '../ChainSyncService'
import { markTxQueueFailed as sharedMarkTxQueueFailed } from '../../utils/txQueueFailure'
import { incrementSessionSpent } from '../../utils/sessionSpendTracker'

// ABI for the new packed-calldata CawActions functions
const PACKED_ABI = [
  'function processActions(uint32 validatorId, bytes packedActions, bytes sigs, uint256 withdrawFee, uint256 withdrawLzTokenAmount) payable',
  'function safeProcessActions(uint32 validatorId, bytes packedActions, bytes sigs, uint256 withdrawFee, uint256 withdrawLzTokenAmount) payable returns (uint256 successCount, string[] rejections)',
  'event ActionsProcessed(bytes packedActions)',
  'event ActionRejected(uint32 senderId, uint32 cawonce, string reason)',
]
const packedIface = new Interface(PACKED_ABI)

// Thin wrapper so this service's existing callers don't need to pass prisma
// on every invocation. Shared helper lives in utils/txQueueFailure so it can
// be reused from DataCleaner (which uses its own PrismaClient instance).
async function markTxQueueFailed(
  txQueueId: number,
  reason: string,
  senderId: number,
  actionData: any
): Promise<void> {
  return sharedMarkTxQueueFailed(prisma as any, txQueueId, reason, senderId, actionData)
}

// How long a txqueue can sit in 'awaiting_indexer' before we give up and
// declare it a real failure. The contract said the cawonce was used, but
// our local Action table never caught up — at that point we have to
// assume the indexer is broken or the action genuinely doesn't exist.
const AWAITING_INDEXER_TIMEOUT_MS = 60_000

/**
 * Resolve a "Cawonce already used" simulation rejection by checking our
 * local Action table.
 *
 * The contract is the source of truth on whether `(senderId, cawonce)` is
 * used, but it doesn't store the action contents — so to decide whether
 * the existing on-chain action is OURS (just not yet indexed locally) or
 * a genuine collision with a different action, we have to match the
 * contents against the Action row the ActionProcessor writes from the
 * `ActionsProcessed` event. That indexer can lag the chain by several
 * seconds, especially during retry storms — so when the row isn't there
 * yet, we defer instead of immediately failing.
 *
 * Returns:
 *   'done'              — Action row exists and matches our payload; it's our action.
 *   'failed'            — Action row exists but is a different action at this cawonce.
 *   'awaiting_indexer'  — Action row not yet present; recheck on next tick.
 */
async function resolveCawonceUsed(data: any, firstSeenAt?: Date): Promise<'done' | 'failed' | 'awaiting_indexer'> {
  const existingAction = await prisma.action.findFirst({
    where: { senderId: data.senderId, cawonce: data.cawonce }
  })
  if (existingAction) {
    const ex = existingAction.data as any
    const sameAction =
      Number(ex?.actionType ?? -1) === Number(data.actionType) &&
      Number(ex?.receiverId ?? -1) === Number(data.receiverId ?? 0) &&
      Number(ex?.receiverCawonce ?? -1) === Number(data.receiverCawonce ?? 0) &&
      (ex?.text ?? '') === (data.text ?? '')
    return sameAction ? 'done' : 'failed'
  }
  // No Action row yet. Either the indexer hasn't caught up, or the cawonce
  // really is a phantom (eg. used by a tx that failed receipt verification
  // but still triggered the on-chain bitmap). Give the indexer a window;
  // if we've been waiting past the timeout, treat it as a real failure.
  if (firstSeenAt && Date.now() - firstSeenAt.getTime() > AWAITING_INDEXER_TIMEOUT_MS) {
    return 'failed'
  }
  return 'awaiting_indexer'
}

/** Build { CAW: 3, LIKE: 2, ... } breakdown from submitted actions (which have actionType) */
function buildActionBreakdown(actions: any[]): Record<string, number> {
  const breakdown: Record<string, number> = {}
  for (const a of actions) {
    if (a.actionType === undefined) continue
    const type = getActionType(Number(a.actionType)).toString()
    breakdown[type] = (breakdown[type] || 0) + 1
  }
  return breakdown
}


// Uniswap V2 Router ABI (minimal for getAmountsOut) - fallback if cache is stale
const UNISWAP_V2_ROUTER_ABI = [
  {
    constant: true,
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'path', type: 'address[]' }
    ],
    name: 'getAmountsOut',
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    type: 'function'
  }
]

const UNISWAP_V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'

// Base Sepolia chain ID for testnet detection
const BASE_SEPOLIA_CHAIN_ID = 84532

// On testnet, gas is essentially free but we still want to validate the check works.
// This factor scales down the gas cost to simulate mainnet-like economics.
// e.g., if testnet gas is 1000x cheaper, we divide gas cost by 1000.
const TESTNET_GAS_SCALE_FACTOR = BigInt(10000)

// Cache for Uniswap router instance
let cachedRouter: Contract | null = null
let cachedMainnetProvider: JsonRpcProvider | null = null

/**
 * Get or create Uniswap V2 Router instance
 */
function getUniswapRouter(mainnetRpcUrl: string): Contract {
  if (!cachedRouter || !cachedMainnetProvider) {
    cachedMainnetProvider = makeJsonRpcProvider(mainnetRpcUrl, 1)
    cachedRouter = new Contract(UNISWAP_V2_ROUTER, UNISWAP_V2_ROUTER_ABI, cachedMainnetProvider)
  }
  return cachedRouter
}


// Tip constants - must match frontend actions.ts
// These are in whole CAW tokens (contract multiplies by 10^18 on-chain)
// At ~500k CAW = $0.01, 1k CAW ≈ $0.00002 per action
const DEFAULT_VALIDATOR_TIP = BigInt(process.env.VALIDATOR_BASE_TIP || "1000") // 1k CAW base tip

/** Live settings loaded from DB, refreshed each poll cycle */
const liveSettings = {
  validatorBaseTip: DEFAULT_VALIDATOR_TIP,
  /** Tip at or above which an action gets priority processing (next poll cycle, no batch wait).
   *  Actions between baseTip and priorityTip are processed on the normal batch cadence. */
  priorityTip: DEFAULT_VALIDATOR_TIP * 3n,
  checkInterval: 10_000,
  minActionsPerBatch: 1,
  maxWaitTime: 10_000,    // 10s default — users shouldn't wait long for standard-tip posts
  replicationInterval: 60_000,
  /** If true, this validator processes actions with a zero tip (public-goods mode).
   *  If false (default), zero-tip actions are rejected and must be processed by a validator
   *  that opts in. Allows users to set "No tip" in Quick Sign for free-but-slow processing. */
  acceptZeroTip: false,
}

/** Load settings from ValidatorSetting table, falling back to defaults */
async function refreshSettings(configCheckInterval?: number) {
  try {
    const rows = await prisma.validatorSetting.findMany()
    const map = new Map(rows.map(r => [r.key, r.value]))
    if (map.has('validatorBaseTip'))    liveSettings.validatorBaseTip = BigInt(map.get('validatorBaseTip')!)
    if (map.has('priorityTip'))        liveSettings.priorityTip = BigInt(map.get('priorityTip')!) || DEFAULT_VALIDATOR_TIP * 3n
    if (map.has('checkInterval'))       liveSettings.checkInterval = Number(map.get('checkInterval')!) || configCheckInterval || 10_000
    if (map.has('minActionsPerBatch'))  liveSettings.minActionsPerBatch = Number(map.get('minActionsPerBatch')!) || 1
    if (map.has('maxWaitTime'))         liveSettings.maxWaitTime = Number(map.get('maxWaitTime')!) || 10_000
    if (map.has('replicationInterval')) liveSettings.replicationInterval = Number(map.get('replicationInterval')!) || 60_000
    if (map.has('acceptZeroTip'))       liveSettings.acceptZeroTip = map.get('acceptZeroTip') === 'true'
  } catch (e: any) {
    console.error('[Validator] Failed to refresh settings from DB:', e.message)
  }
}

/**
 * Calculate the minimum required tip for an action
 * @returns Minimum required tip in CAW
 */
function calculateMinimumTip(): bigint {
  return liveSettings.validatorBaseTip
}

/**
 * Check if an action's tip qualifies for priority processing (skip batch wait).
 * @param action The action data (tip is last element of amounts array)
 */
function isPriorityAction(action: any): boolean {
  const amounts = action.amounts || []
  if (amounts.length === 0) return false
  const tip = BigInt(amounts[amounts.length - 1] || '0')
  return tip >= liveSettings.priorityTip
}

/**
 * Validate that an action's tip is sufficient for the client's replication count
 * @param action - The action data
 * @param l2RpcUrl - L2 RPC URL for contract query
 * @returns Validation result with details
 */
async function validateActionTip(
  action: any,
): Promise<{ valid: boolean; reason?: string; required?: bigint; provided?: bigint }> {
  const requiredTip = calculateMinimumTip()

  // Get the tip from the action's amounts array (last element is the tip)
  const amounts = action.amounts || []
  if (amounts.length === 0) {
    // No amounts at all — only acceptable if this validator opts into zero-tip processing.
    if (liveSettings.acceptZeroTip) {
      return { valid: true }
    }
    return {
      valid: false,
      reason: `No tip provided. Required: ${requiredTip.toString()} CAW`,
      required: requiredTip,
      provided: BigInt(0)
    }
  }

  const providedTip = BigInt(amounts[amounts.length - 1] || '0')

  // Zero-tip path: opt-in only (public-goods validators).
  // Users who picked "No tip" in Quick Sign sign actions with tip=0; only validators that
  // opted into acceptZeroTip will process them.
  if (providedTip === 0n && liveSettings.acceptZeroTip) {
    return { valid: true }
  }

  if (providedTip < requiredTip) {
    console.log(`[Validator] Insufficient tip for action:`)
    console.log(`  - Required tip: ${requiredTip.toString()} CAW`)
    console.log(`  - Provided tip: ${providedTip.toString()} CAW`)
    return {
      valid: false,
      reason: `Insufficient tip: provided ${providedTip.toString()} CAW, required ${requiredTip.toString()} CAW`,
      required: requiredTip,
      provided: providedTip
    }
  }

  return { valid: true }
}

/**
 * Get unique client IDs from a batch of actions
 */
function getUniqueClientIds(actions: any[]): number[] {
  const clientIds = new Set<number>()
  for (const action of actions) {
    clientIds.add(action.clientId ?? 1)
  }
  return Array.from(clientIds)
}

/**
 * Split actions by client ID for batching
 * Returns map of clientId -> indices of actions for that client
 */
function groupActionsByClient(actions: any[]): Map<number, number[]> {
  const groups = new Map<number, number[]>()
  for (let i = 0; i < actions.length; i++) {
    const clientId = actions[i].clientId ?? 1
    if (!groups.has(clientId)) {
      groups.set(clientId, [])
    }
    groups.get(clientId)!.push(i)
  }
  return groups
}

/**
 * Convert CAW amount to ETH using cached price or Uniswap V2 getAmountsOut
 * @param cawAmount - Amount of CAW tokens (raw count, not wei)
 * @param mainnetRpcUrl - Mainnet RPC URL for Uniswap query (fallback)
 * @returns Amount of ETH (in wei) that the CAW would swap to
 */
async function cawToEth(cawAmount: bigint, mainnetRpcUrl: string): Promise<bigint> {
  if (cawAmount === BigInt(0)) {
    return BigInt(0)
  }

  // Try to use cached price first (refreshed every 5 minutes by ChainSyncService)
  if (isPriceFresh(10 * 60 * 1000)) { // Accept prices up to 10 minutes old
    const cachedResult = cawToEthCached(cawAmount)
    if (cachedResult !== null) {
      console.log(`[Validator] Using cached CAW/ETH price`)
      return cachedResult
    }
  }

  // Fallback to direct Uniswap query if cache is stale
  console.log(`[Validator] Cache miss - querying Uniswap directly`)
  try {
    const router = getUniswapRouter(mainnetRpcUrl)
    const path = [CAW_ADDRESS, WETH_ADDRESS]

    // CAW has 18 decimals, so cawAmount should already be in the correct units
    // But our tip is just the raw CAW count, so we need to add 18 decimals
    const cawAmountWithDecimals = cawAmount * BigInt(10 ** 18)

    const amounts = await router.getAmountsOut(cawAmountWithDecimals, path)
    const ethOut = BigInt(amounts[1])

    return ethOut
  } catch (error: any) {
    console.error('[Validator] Failed to convert CAW to ETH via Uniswap:', error.message)
    // Fallback: use approximate rate (this is a safety net)
    // ~16M wei per CAW based on historical rates
    return cawAmount * BigInt(16140000)
  }
}

/** natstat: validator configuration schema */
const ValidatorConfig = z.object({
  l2RpcUrl:      z.string(),
  ethMainnetRpcUrl: z.string().optional(), // Ethereum L1 mainnet for Uniswap CAW price
  validatorId:   z.number().int(),
  checkInterval: z.number().default(10_000)  // ms
})
type ValidatorConfig = z.infer<typeof ValidatorConfig>

/** natstat: the Validator service polls pending txQueue entries, simulates them,
 *  and submits only those whose tips cover gas + whose simulation passed.
 */
export const validatorService: Service = {
  name: 'Validator',

  validateConfig(raw) {
    const result = ValidatorConfig.safeParse(raw)
    return result.success
      ? []
      : result.error.errors.map(e => new Error(e.message))
  },

  start(rawCfg, ctx) {
    const cfg = ValidatorConfig.parse(rawCfg)
    // Prefer environment variable for RPC URL (never commit API keys to config)
    const l2RpcUrl = process.env.L2_RPC_URL || cfg.l2RpcUrl
    // ETH L1 mainnet RPC for Uniswap CAW price queries (separate from L2 RPC)
    const ethMainnetRpcUrl = process.env.ETH_MAINNET_RPC_URL || cfg.ethMainnetRpcUrl || 'https://eth.llamarpc.com'
    const { validatorId, checkInterval } = cfg

    if (!l2RpcUrl || l2RpcUrl.includes('${')) {
      throw new Error('Missing L2_RPC_URL in environment variables')
    }

    const privateKey = process.env.VALIDATOR_PRIVATE_KEY
    if (!privateKey) throw new Error('Missing VALIDATOR_PRIVATE_KEY in env')

    let provider: WebSocketProvider
    let wallet: Wallet
    let cawActions: Contract
    let iface: any

    // Dedicated HTTP provider for read-heavy calls (eth_call with large calldata,
    // gas estimation, fee data). Infura WSS on Base Sepolia hangs/socket-hang-ups
    // under large eth_call payloads (we routinely simulate 50+ actions in one
    // call). HTTP handles these reliably. Subscriptions can stay on WSS.
    const l2HttpRpcUrl = getL2HttpRpcUrl(l2RpcUrl)
    const httpProvider = makeJsonRpcProvider(l2HttpRpcUrl, 84532)
    console.log(`[Validator] HTTP RPC (for eth_call / gas): ${l2HttpRpcUrl.slice(0, 50)}...`)

    // Note: Uncaught exception handling is done at the process level in programs/start.ts
    // No need for service-specific handlers

    // WebSocket is DISABLED by default. Infura rate-limits eth_subscribe very
    // aggressively and reconnect storms were the biggest source of sustained
    // 429s in the stack. The validator doesn't actually need WS — every
    // read (simulation, gas, fee data) and write (tx submission) uses the
    // httpProvider path. WS was only being used as the wallet's default
    // provider. Re-enable with ENABLE_VALIDATOR_WS=1.
    const USE_WS = process.env.ENABLE_VALIDATOR_WS === '1'

    // Function to initialize/reinitialize the WebSocket connection
    async function initializeConnection() {
      if (!USE_WS) {
        // No-WS path: bind wallet/contract to the HTTP provider instead.
        provider = httpProvider as unknown as WebSocketProvider
        wallet = new Wallet(privateKey!, httpProvider)
        cawActions = new Contract(CAW_ACTIONS_ADDRESS, cawActionsAbi, wallet)
        iface = cawActions.interface
        console.log('[Validator] WebSocket disabled — using HTTP provider (set ENABLE_VALIDATOR_WS=1 to re-enable)')
        return
      }
      console.log('[Validator] Initializing WebSocket connection...')
      if (provider) {
        try {
          // Set a flag to prevent the provider from being used during cleanup
          const oldProvider = provider
          provider = null as any // Clear reference immediately

          // Safely destroy the old provider
          setTimeout(async () => {
            try {
              // Check if the WebSocket exists and its state
              const ws = (oldProvider as any)._websocket || (oldProvider as any).websocket
              if (ws) {
                const readyState = ws.readyState
                console.log(`[Validator] Old WebSocket state: ${readyState} (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED)`)

                // Only destroy if the WebSocket is OPEN (1) or already CLOSED (3)
                // Don't try to destroy CONNECTING (0) or CLOSING (2) sockets
                if (readyState === 1 || readyState === 3) {
                  oldProvider.destroy()
                  console.log('[Validator] Old provider destroyed successfully')
                } else {
                  // For CONNECTING or CLOSING states, just wait for it to close naturally
                  console.log('[Validator] Skipping destroy - WebSocket not in stable state')
                  if (readyState === 0) {
                    // If still connecting, wait a bit and try to close again
                    setTimeout(() => {
                      try {
                        if (ws.readyState === 1) {
                          ws.close()
                        }
                      } catch (e) {
                        // Ignore errors during delayed close
                      }
                    }, 1000)
                  }
                }
              } else {
                // No WebSocket found, safe to destroy
                oldProvider.destroy()
                console.log('[Validator] Old provider destroyed (no active WebSocket)')
              }
            } catch (e: any) {
              console.log('[Validator] Error destroying old provider (non-fatal):', e.message)
            }
          }, 500) // Longer delay to ensure operations complete
        } catch (e: any) {
          console.log('[Validator] Error during provider cleanup (non-fatal):', e.message)
        }
      }

      // Create new provider with error handling
      try {
        provider = makeWebSocketProvider(l2RpcUrl, 84532) // Base Sepolia chainId

        // Add error handler to the WebSocket immediately to catch connection errors
        const ws = (provider as any)._websocket || (provider as any).websocket
        if (ws) {
          ws.on('error', (error: Error) => {
            if (error.message?.includes('429')) {
              console.log('[Validator] WebSocket rate limited (429), will retry later')
            } else {
              console.log('[Validator] WebSocket error:', error.message)
            }
          })
        }

        wallet = new Wallet(privateKey!, provider)
        cawActions = new Contract(CAW_ACTIONS_ADDRESS, cawActionsAbi, wallet)
        iface = cawActions.interface

        // Wait for the provider to be ready
        try {
          await provider.getNetwork()
          console.log('[Validator] WebSocket connection initialized and ready')
        } catch (e: any) {
          console.log('[Validator] WebSocket connection initialized (network check failed, will retry):', e.message)
        }
      } catch (e: any) {
        console.log('[Validator] Error creating WebSocket provider:', e.message)
        // Create a dummy provider to prevent errors
        provider = null as any
      }
    }

    // Initialize connection
    initializeConnection().catch(e => {
      console.log('[Validator] Error during initial connection, will retry:', e.message)
    })

    // On startup, reset ALL 'processing' entries back to 'pending'
    // These are definitely stale since we just started
    prisma.txQueue.updateMany({
      where: { status: 'processing' },
      data: { status: 'pending' }
    }).then(result => {
      if (result.count > 0) {
        console.log(`[Validator] Startup: Reset ${result.count} 'processing' entries back to 'pending'`)
      }
    }).catch(err => {
      console.error('[Validator] Startup: Failed to reset processing entries:', err.message)
    })

    let timer: NodeJS.Timeout

    /** natstat: load all pending queue entries */
    async function fetchPendingQueue() {
      // Reset any 'processing' entries older than 30 seconds (likely stale from timeout/crash)
      const thirtySecondsAgo = new Date(Date.now() - 30 * 1000)
      const resetCount = await prisma.txQueue.updateMany({
        where: {
          status: 'processing',
          updatedAt: { lt: thirtySecondsAgo }
        },
        data: { status: 'pending' }
      })
      if (resetCount.count > 0) {
        console.log(`[Validator] Reset ${resetCount.count} stale 'processing' entries back to 'pending'`)
      }

      // waiting_for_deposit lifecycle:
      //   - Rows carry pendingDepositTxHash as proof the client expects an L1 deposit
      //     to land on L2 shortly. They are NOT re-simulated by the validator — that
      //     would cycle them right back to failed. Instead, the DataCleaner watcher
      //     reads L2 on-chain state (authenticated[clientId][tokenId] and
      //     cawBalanceOf(tokenId)) and promotes them back to 'pending' only when the
      //     deposit has actually landed. The watcher also handles the 20-min timeout
      //     and failure path. The validator's only job here is to hard-fail any
      //     waiting row older than 25 minutes as a last-resort safety net in case
      //     the watcher is down.
      const twentyFiveMinutesAgo = new Date(Date.now() - 25 * 60 * 1000)
      const staleWaitingRows = await prisma.txQueue.findMany({
        where: {
          status: 'waiting_for_deposit',
          createdAt: { lt: twentyFiveMinutesAgo }
        },
        select: { id: true, senderId: true, payload: true }
      })
      if (staleWaitingRows.length > 0) {
        console.log(`[Validator] Safety net: failing ${staleWaitingRows.length} waiting_for_deposit rows older than 25 min`)
        for (const row of staleWaitingRows) {
          const data = (row.payload as any)?.data ?? {}
          await markTxQueueFailed(
            row.id,
            'Deposit did not arrive in time. Please try again.',
            row.senderId,
            data
          )
        }
      }

      // Pre-simulation hold: any pending row carrying a pendingDepositTxHash gets
      // moved to waiting_for_deposit WITHOUT simulation. Attempting to simulate
      // these would fail with "User has not authenticated with this client" or
      // "Insufficient CAW balance" (since L1→L2 hasn't propagated yet) and waste
      // an RPC call. The DataCleaner watcher will re-promote once L2 catches up.
      const heldCount = await prisma.txQueue.updateMany({
        where: {
          status: 'pending',
          pendingDepositTxHash: { not: null }
        },
        data: {
          status: 'waiting_for_deposit',
          reason: 'Waiting for L1 deposit to land on L2'
        }
      })
      if (heldCount.count > 0) {
        console.log(`[Validator] Pre-sim hold: moved ${heldCount.count} rows to waiting_for_deposit`)
      }

      // awaiting_indexer recheck: rows where simulation reported "Cawonce
      // already used" but the local Action row hadn't been written yet.
      // Re-resolve against the Action table (now updated by ActionProcessor)
      // and either close them out or, if we've waited past the timeout,
      // fail them. Skip simulation entirely for these — the contract's
      // verdict on the cawonce hasn't changed; only our local view of the
      // action contents has.
      const awaitingRows = await prisma.txQueue.findMany({
        where: { status: 'awaiting_indexer' },
        select: { id: true, payload: true, senderId: true, updatedAt: true },
      })
      if (awaitingRows.length > 0) {
        console.log(`[Validator] Rechecking ${awaitingRows.length} awaiting_indexer row(s)`)
        await Promise.all(awaitingRows.map(async (row) => {
          const data = (row.payload as any)?.data
          if (!data) return
          const resolution = await resolveCawonceUsed(data, row.updatedAt)
          if (resolution === 'done') {
            console.log(`[Validator] TxQueue ${row.id}: Action row now indexed and matches — marking done`)
            await prisma.txQueue.update({
              where: { id: row.id },
              data: { status: 'done', reason: null },
            })
            // Also mark the optimistic Caw row SUCCESS for caw/recaw actions, mirroring updateQueueStatuses.
            if (data.actionType === 0 || data.actionType === 'caw' || data.actionType === 3 || data.actionType === 'recaw') {
              await prisma.caw.update({
                where: { userId_cawonce: { userId: data.senderId, cawonce: data.cawonce } },
                data: { status: 'SUCCESS' },
              }).catch(() => {})
            }
          } else if (resolution === 'failed') {
            console.log(`[Validator] TxQueue ${row.id}: gave up on awaiting_indexer (different action or indexer timeout)`)
            await markTxQueueFailed(row.id, 'Cawonce already used', row.senderId, data)
          }
          // 'awaiting_indexer' — leave the row alone; do NOT re-update,
          // since that would bump updatedAt and reset the timeout.
        }))
      }

      // Fetch more candidates than we might use so we can stop at the size limit.
      // Base Sepolia transaction size limit is 128KB. We target ~80KB of action
      // data to leave headroom for signatures, arrays, and ABI encoding overhead.
      const candidates = await prisma.txQueue.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        take: 256,
      })

      // Bound the batch by estimated calldata size. With packed format, each
      // action is ~25 bytes fixed + 65 bytes sig = 90 bytes + text + arrays.
      // Cap at 120KB to leave margin below the 128KB protocol tx size limit.
      const MAX_BATCH_CALLDATA_BYTES = 120_000
      const PER_ACTION_OVERHEAD = 90 // packed fixed fields (25) + sig (65)
      let runningSize = 500 // base overhead for the outer function call
      const bounded: typeof candidates = []
      for (const entry of candidates) {
        const data = (entry.payload as any)?.data
        // text is a hex string (0x...) — actual byte length is (length - 2) / 2
        const textHex = typeof data?.text === 'string' ? data.text : ''
        const textLen = textHex.startsWith('0x') ? (textHex.length - 2) / 2 : textHex.length / 2
        const recipientsLen = Array.isArray(data?.recipients) ? data.recipients.length * 4 : 0
        const amountsLen = Array.isArray(data?.amounts) ? data.amounts.length * 8 : 0
        const entrySize = PER_ACTION_OVERHEAD + textLen + recipientsLen + amountsLen
        if (bounded.length > 0 && runningSize + entrySize > MAX_BATCH_CALLDATA_BYTES) {
          console.log(`[Validator] Batch size limit reached at ${bounded.length} entries (~${runningSize} bytes). Deferring ${candidates.length - bounded.length} entries to next poll.`)
          break
        }
        bounded.push(entry)
        runningSize += entrySize
      }

      return bounded
    }

    /** natstat: split each raw signedTx into r, s, v and collect action payloads */
    function buildMultiActionData(
      queueEntries: Array<{ payload: any; signedTx: string }>
    ) {
      const actions: any[]    = []
      const sigParts: Array<{ v: number; r: string; s: string }> = []

      for (const entry of queueEntries) {
        const signature = entry.signedTx
        const hex = signature.startsWith('0x') ? signature.slice(2) : signature

        sigParts.push({
          r: '0x' + hex.slice(0, 64),
          s: '0x' + hex.slice(64, 128),
          v: parseInt(hex.slice(128, 130), 16),
        })

        // Ensure amounts are properly formatted
        const actionData = (entry.payload as any).data
        const recipients = Array.isArray(actionData.recipients) ? actionData.recipients.map(Number) : []
        const amounts = Array.isArray(actionData.amounts)
          ? actionData.amounts.map((amt: any) => {
              if (amt === null || amt === undefined || amt === '') return '0'
              const strAmt = String(amt)
              return (strAmt === 'NaN' || isNaN(Number(strAmt))) ? '0' : strAmt
            })
          : []

        // Ensure amounts has exactly recipients.length + 1 entries for packed format
        while (amounts.length < recipients.length + 1) amounts.push('0')

        actions.push({
          ...actionData,
          recipients,
          amounts,
        })
      }

      // Build packed format
      const packedBytes = packActions(actions.map(a => ({
        actionType: Number(a.actionType),
        senderId: Number(a.senderId),
        receiverId: Number(a.receiverId || 0),
        receiverCawonce: Number(a.receiverCawonce || 0),
        clientId: Number(a.clientId),
        cawonce: Number(a.cawonce),
        recipients: (a.recipients || []).map(Number),
        amounts: a.amounts.map((x: any) => BigInt(x)),
        text: a.text || '0x',
      })))
      const sigsBytes = packSignatures(sigParts)

      return {
        actions,
        v: sigParts.map(s => s.v),
        r: sigParts.map(s => s.r),
        s: sigParts.map(s => s.s),
        // Packed format for the new contract
        packedActions: bytesToHex(packedBytes),
        packedSigs: bytesToHex(sigsBytes),
      }
    }


    async function simulateActions(
      validatorId: number,
      multiData: { actions: any[]; v: number[]; r: string[]; s: string[]; packedActions: string; packedSigs: string },
      retryCount: number = 0
    ): Promise<{ successfulActions: any[], rejectionMessages: string[], quote: any }> {
      const maxRetries = 3;

      try {
        console.log(`[Attempt ${retryCount + 1}/${maxRetries}] Simulating actions with RPC: ${l2RpcUrl}`);
        console.log("Actions to simulate:", multiData.actions.map(a => ({
          type: getActionType(a.actionType).toString(),
          sender: a.senderId,
          cawonce: a.cawonce
        })));

        // Get withdrawal quote if there are any withdrawals
        console.log("[Validator] Step 1: Checking for withdrawals...")
        const withdraws = multiData.actions.filter((action: any) => getActionType(action.actionType).toString() === 'WITHDRAW')
        let withdrawQuote = { nativeFee: BigInt(0), lzTokenFee: BigInt(0) }
        console.log(`[Validator] Found ${withdraws.length} withdrawal actions`)
        if (withdraws.length > 0) {
          const tokenIds = withdraws.map((action: any) => action.senderId)
          // Convert amounts from whole CAW units to wei (action struct uses uint64, so amounts are not in wei)
          const amounts = withdraws.map((action: any) => BigInt(action.amounts[0]) * 10n**18n)
          console.log("[Validator] Getting withdraw quote for tokenIds:", tokenIds, "amounts (in wei):", amounts)
          try {
            // Add timeout to withdrawQuote call
            const quotePromise = cawActions.withdrawQuote(tokenIds, amounts, false)
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error('withdrawQuote timeout after 10s')), 10000)
            })
            withdrawQuote = await Promise.race([quotePromise, timeoutPromise]) as any
            console.log('[Validator] Withdraw quote:', withdrawQuote)
          } catch (err: any) {
            console.error("[Validator] Failed to get withdraw quote:", err.message || err)
          }
        }

        // Build the quote object (withdraw fees only — replication is handled separately)
        const quote = {
          nativeFee: BigInt(withdrawQuote.nativeFee || 0),
          withdrawFee: BigInt(withdrawQuote.nativeFee || 0),
          withdrawLzTokenAmount: BigInt(withdrawQuote.lzTokenFee || 0),
        }

        console.log("[Validator] Step 2: Building quote object...")
        console.log("[Validator] Total fees:", {
          withdrawFee: quote.withdrawFee.toString(),
          totalNativeFee: quote.nativeFee.toString()
        })

        // ABI‐encode with the 4-argument signature (replication is handled separately)
        console.log("[Validator] Step 3: Encoding calldata...")
        let calldata: string
        try {
          calldata = packedIface.encodeFunctionData('safeProcessActions', [
            validatorId,
            multiData.packedActions,
            multiData.packedSigs,
            quote.withdrawFee,
            quote.withdrawLzTokenAmount,
          ])
          console.log(`[Validator] Calldata encoded successfully (${calldata.length} chars)`)
        } catch (encodeErr: any) {
          console.error(`[Validator] FAILED to encode calldata:`, encodeErr.message)
          throw encodeErr
        }
        console.log(`Calldata prepared, simulating transaction...`)
        console.log(`  - Contract: ${CAW_ACTIONS_ADDRESS}`)
        console.log(`  - Value: ${quote?.nativeFee?.toString() || '0'}`)
        console.log(`  - Actions: ${multiData.actions.length}`)
        console.log(`  - Action details:`, multiData.actions.map(a => ({
          type: getActionType(a.actionType).toString(),
          senderId: a.senderId,
          receiverId: a.receiverId,
          cawonce: a.cawonce
        })))

        console.log("[Validator] Step 5: Making RPC call...")
        const startTime = Date.now();

        // Use the HTTP provider for simulation — WSS hangs on large eth_call
        // payloads (50+ actions worth of calldata saturates the socket).
        console.log(`[Validator] Calling httpProvider.call() to ${CAW_ACTIONS_ADDRESS} with value ${quote?.nativeFee?.toString() || '0'}`)
        const callPromise = httpProvider.call({
          to: CAW_ACTIONS_ADDRESS,
          data: calldata,
          value: quote?.nativeFee
        })

        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('RPC call timeout after 30 seconds')), 30000)
        })

        let returnData: string
        try {
          console.log("[Validator] Awaiting RPC response (30s timeout)...")
          returnData = await Promise.race([callPromise, timeoutPromise]) as string
          console.log(`[Validator] RPC call returned data (${returnData?.length || 0} chars)`)
        } catch (timeoutErr: any) {
          console.error('[Validator] RPC call timeout or error:', timeoutErr.message)
          console.error('[Validator] Full timeout error:', timeoutErr)
          // No WSS reinit needed — we're on HTTP now, each request is independent.
          throw timeoutErr
        }

        const elapsed = Date.now() - startTime;

        console.log(`[Validator] Step 6: Decoding response...`)
        console.log(`Simulation completed in ${elapsed}ms`)
        const decoded = packedIface.decodeFunctionResult(
          'safeProcessActions',
          returnData
        ) as [ bigint, string[] ]  // [ successCount, rejectionMessages ]
        console.log("decoded", decoded)

        const [ successCount, rejectionMessages ] = decoded
        // Build a minimal successfulActions array from the non-rejected entries
        const successfulActions = multiData.actions.filter((_: any, i: number) => !rejectionMessages[i])

        console.log("simulated:", Number(successCount), rejectionMessages)
        console.log("[Validator] Simulation results:")
        console.log(`  - Successful actions: ${successfulActions.length}`)
        if (successfulActions.length > 0) {
          console.log("  - Successful action details:", successfulActions.map((action: any, i: number) => ({
            index: i,
            type: getActionType(action.actionType).toString(),
            sender: action.senderId,
            receiver: action.receiverId,
            cawonce: action.cawonce,
            amounts: action.amounts?.map((a: any) => a.toString())
          })))
        }
        if (rejectionMessages.length > 0) {
          console.log(`  - Rejected actions: ${rejectionMessages.length}`)
          rejectionMessages.forEach((msg: string, i: number) => {
            if (msg) console.log(`    [${i}] Rejection reason: ${msg}`)
          })
        }
        return { successfulActions, rejectionMessages, quote }
      } catch (err: any) {
        // Log full error details
        console.error(`[Attempt ${retryCount + 1}] Simulation failed:`, {
          error: err.message || err,
          stack: err.stack,
          rpcUrl: l2RpcUrl,
          actions: multiData.actions.map(a => ({
            type: getActionType(a.actionType).toString(),
            sender: a.senderId,
            cawonce: a.cawonce
          }))
        });

        // Handle specific blockchain errors (these don't need retry)
        if (err.message?.includes('execution reverted')) {
          const revertMatch = err.message.match(/execution reverted: (.+)/);
          const revertReason = revertMatch?.[1] || err.message;
          console.log(`Execution reverted with reason: ${revertReason}`);

          // Check for specific duplicate cawonce error
          if (revertReason.includes('cawonce') || revertReason.includes('already processed')) {
            const rejectionMessages = multiData.actions.map(() =>
              `Transaction already processed - duplicate cawonce`
            );
            return { successfulActions: [], rejectionMessages, quote: { nativeFee: BigInt(0) } };
          }

          const rejectionMessages = multiData.actions.map(() =>
            `Transaction reverted: ${revertReason}`
          );
          return { successfulActions: [], rejectionMessages, quote: { nativeFee: BigInt(0) } };
        }

        // Handle timeout errors - mark as temporary failure, don't mark as failed
        if (err.message?.includes('timeout')) {
          console.log('[Validator] RPC timeout detected - will retry on next poll')
          const rejectionMessages = multiData.actions.map(() =>
            'RPC timeout - will retry'
          );
          return { successfulActions: [], rejectionMessages, quote: { nativeFee: BigInt(0) } };
        }

        // Handle provider/network errors - reinitialize connection and mark as temporary failure
        if (err.message?.includes('provider destroyed') ||
            err.message?.includes('UNSUPPORTED_OPERATION') ||
            err.message?.includes('cancelled request') ||
            err.code === 'UNSUPPORTED_OPERATION') {
          console.log('[Validator] Provider/network error detected - reinitializing connection')
          initializeConnection()
          const rejectionMessages = multiData.actions.map(() =>
            'Network error - will retry'
          );
          return { successfulActions: [], rejectionMessages, quote: { nativeFee: BigInt(0) } };
        }

        // Handle other errors
        const rejectionMessages = multiData.actions.map(() => {
          if (err.message?.includes('insufficient funds')) {
            return 'Insufficient funds for transaction';
          } else if (err.message?.includes('nonce')) {
            return 'Invalid nonce - transaction may be outdated';
          } else if (err.message?.includes('already known')) {
            return 'Transaction already known - duplicate cawonce';
          } else {
            return `Simulation error: ${err.message || 'Unknown error'}`;
          }
        });

        return { successfulActions: [], rejectionMessages, quote: { nativeFee: BigInt(0) } };
      }
    }

    async function estimateProcessGasCost(
      validatorId: number,
      multiData: { actions: any[]; v: number[]; r: string[]; s: string[]; packedActions: string; packedSigs: string },
      quote: { nativeFee: bigint; withdrawFee: bigint; withdrawLzTokenAmount: bigint }
    ) {
      // Calculate gas cost from action count instead of estimateGas.
      // Infura's estimateGas fails with "missing revert data" on large calldata
      // even when eth_call succeeds. ~50K gas/action + 100K base, 30% buffer.
      const actionCount = multiData.actions.length
      const calculatedGas = BigInt(Math.ceil((100_000 + actionCount * 50_000) * 1.3))

      const feeData = await httpProvider.getFeeData()
      const gasPrice = feeData.gasPrice ?? BigInt(0)

      return calculatedGas * gasPrice;
    }


    /** natstat: estimate the raw gas‐limit for processActions */
    async function estimateGasLimit(
      validatorId: number,
      multiData: { actions: any[]; v: number[]; r: string[]; s: string[]; packedActions: string; packedSigs: string },
      quote: { nativeFee: bigint; withdrawFee: bigint; withdrawLzTokenAmount: bigint }
    ): Promise<bigint> {
      // 1) ABI-encode the same calldata you'd send on-chain
      const calldata = packedIface.encodeFunctionData('processActions', [
        validatorId,
        multiData.packedActions,
        multiData.packedSigs,
        quote.withdrawFee,
        quote.withdrawLzTokenAmount,
      ]);

      // Calculate gas limit from action count instead of estimateGas.
      // Infura's estimateGas fails with "missing revert data" on large calldata
      // even when eth_call succeeds. ~50K gas/action + 100K base, 30% buffer.
      const actionCount = multiData.actions.length
      return BigInt(Math.ceil((100_000 + actionCount * 50_000) * 1.3));
    }


    async function submitProcessActions(
      validatorId: number,
      multiData: { actions: any[]; v: number[]; r: string[]; s: string[]; packedActions: string; packedSigs: string },
      quote: { nativeFee: bigint; withdrawFee: bigint; withdrawLzTokenAmount: bigint },
      rawGasLimit: bigint,
      retryCount: number = 0
    ) {
      const maxRetries = 3
      const gasBumpPercent = 15 // Increase gas by 15% on each retry

      const feeData = await httpProvider.getFeeData();

      // Pre-fetch nonce so sendTransaction doesn't need to (throttle handles spacing)
      const nonce = await httpProvider.getTransactionCount(wallet.address, 'pending')

      // Bump gas fees on retry to handle REPLACEMENT_UNDERPRICED errors
      let maxFeePerGas = feeData.maxFeePerGas ?? BigInt(0)
      let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? BigInt(0)

      if (retryCount > 0) {
        const multiplier = BigInt(100 + (gasBumpPercent * retryCount))
        maxFeePerGas = (maxFeePerGas * multiplier) / BigInt(100)
        maxPriorityFeePerGas = (maxPriorityFeePerGas * multiplier) / BigInt(100)
        console.log(`[submitProcessActions] Retry ${retryCount}/${maxRetries}, bumped gas by ${gasBumpPercent * retryCount}%`)
      }

      try {
        // Encode calldata and validate before sending
        const txData = packedIface.encodeFunctionData('processActions', [
          validatorId,
          multiData.packedActions,
          multiData.packedSigs,
          quote.withdrawFee,
          quote.withdrawLzTokenAmount,
        ])

        if (!txData || txData === '0x' || txData.length < 10) {
          console.error('[submitProcessActions] CRITICAL: encodeFunctionData returned empty/invalid data:', {
            txData,
            validatorId,
            actionsCount: multiData.actions.length,
            withdrawFee: quote.withdrawFee.toString(),
            withdrawLzTokenAmount: quote.withdrawLzTokenAmount.toString(),
          })
          throw new Error(`encodeFunctionData produced invalid calldata: "${txData}"`)
        }

        // All params pre-populated so ethers makes exactly 1 RPC call (eth_sendRawTransaction)
        const tx = await wallet.sendTransaction({
          to:    CAW_ACTIONS_ADDRESS,
          data:  txData,
          value: quote.nativeFee,
          nonce,
          gasLimit: rawGasLimit,
          maxFeePerGas,
          maxPriorityFeePerGas,
          chainId: 84532,
          type: 2,
        })
        console.log(`[submitProcessActions] Sent ${multiData.actions.length} action(s), tx=${tx.hash}`)

        const receipt = await tx.wait()

        const evt = receipt?.logs
          ?.map(log => { try { return iface.parseLog(log) } catch { return null } })
          ?.find(x => x?.name === 'ActionsProcessed')

        if (!evt) {
          console.error("[submitProcessActions] ActionsProcessed event missing from receipt!")
          console.error("[submitProcessActions] Receipt logs:", receipt?.logs)
          throw new Error('ActionsProcessed event missing')
        }

        // Decode packed bytes from ActionsProcessed(bytes packedActions) event
        const packedHex = evt.args.packedActions as string
        const packedBuf = new Uint8Array((packedHex.startsWith('0x') ? packedHex.slice(2) : packedHex).match(/.{2}/g)!.map(b => parseInt(b, 16)))
        const decoded = unpackActions(packedBuf)
        const processed = decoded.map(a => ({
          senderId:     Number(a.senderId),
          cawonce:      Number(a.cawonce)
        }))
        console.log(`[submitProcessActions] Confirmed in block ${receipt?.blockNumber} (${processed.length} action(s))`)
        return { processed, receipt }
      } catch (err: any) {
        // Handle "oversized data" — tx calldata exceeds the 128KB protocol limit.
        // Split the batch in half and try again. Uses recursion with a shrinking
        // multiData so at worst we end up submitting one action at a time.
        if (err.message?.includes('oversized data') && multiData.actions.length > 1) {
          const halfLen = Math.floor(multiData.actions.length / 2)
          console.warn(`[submitProcessActions] Oversized tx (${multiData.actions.length} actions). Splitting in half — sending first ${halfLen}, deferring the rest.`)
          const firstHalf = {
            actions: multiData.actions.slice(0, halfLen),
            v: multiData.v.slice(0, halfLen),
            r: multiData.r.slice(0, halfLen),
            s: multiData.s.slice(0, halfLen),
          }
          // Note: quote was computed for the full batch. The withdraw-related
          // portion should still be ≥ what we need for this smaller batch.
          return submitProcessActions(validatorId, firstHalf, quote, rawGasLimit, 0)
        }

        // Handle REPLACEMENT_UNDERPRICED - retry with higher gas
        if (err.code === 'REPLACEMENT_UNDERPRICED' || err.message?.includes('replacement transaction underpriced')) {
          if (retryCount < maxRetries) {
            console.log(`[submitProcessActions] REPLACEMENT_UNDERPRICED error - retrying with higher gas (attempt ${retryCount + 1}/${maxRetries})`)
            // Wait a moment for the mempool to update
            await new Promise(resolve => setTimeout(resolve, 1000))
            return submitProcessActions(validatorId, multiData, quote, rawGasLimit, retryCount + 1)
          } else {
            console.error(`[submitProcessActions] Max retries (${maxRetries}) exceeded for REPLACEMENT_UNDERPRICED error`)
          }
        }

        // Handle "already known" - transaction is already in mempool, wait for it
        if (err.code === 'ALREADY_KNOWN' || err.message?.includes('already known')) {
          console.log('[submitProcessActions] Transaction already known in mempool - waiting for confirmation...')
          // Wait and check if it gets mined
          await new Promise(resolve => setTimeout(resolve, 5000))
          // The transaction might have been mined by now, but we can't track it without the hash
          // Just propagate the error and let it retry on next poll
        }

        // Handle nonce issues - get fresh nonce and retry
        if (err.message?.includes('nonce') && retryCount < maxRetries) {
          console.log(`[submitProcessActions] Nonce issue detected - waiting and retrying (attempt ${retryCount + 1}/${maxRetries})`)
          await new Promise(resolve => setTimeout(resolve, 2000))
          return submitProcessActions(validatorId, multiData, quote, rawGasLimit, retryCount + 1)
        }

        // Handle transient RPC/network errors - retry with backoff
        const isTransient = err.code === 'UNKNOWN_ERROR' ||
          err.code === 'SERVER_ERROR' ||
          err.code === 'TIMEOUT' ||
          err.code === 'NETWORK_ERROR' ||
          err.message?.includes('error sending request') ||
          err.message?.includes('could not coalesce') ||
          err.message?.includes('ECONNREFUSED') ||
          err.message?.includes('ETIMEDOUT') ||
          err.message?.includes('fetch failed') ||
          err.message?.includes('network error')

        if (isTransient && retryCount < maxRetries) {
          const delay = Math.min(2000 * (retryCount + 1), 10000)
          console.log(`[submitProcessActions] Transient RPC error - retrying in ${delay}ms (attempt ${retryCount + 1}/${maxRetries}): ${err.message?.substring(0, 100)}`)
          await new Promise(resolve => setTimeout(resolve, delay))
          return submitProcessActions(validatorId, multiData, quote, rawGasLimit, retryCount + 1)
        }

        throw err
      }
    }

    /**
     * Check if a failed action should wait for a pending deposit instead of failing.
     * Returns 'waiting_for_deposit' if the user has a recent deposit in flight, or 'failed' otherwise.
     */
    // Deposit hold is now driven by TxQueue.pendingDepositTxHash (set by the
    // client at submission time) and the DataCleaner L2 watcher. This function
    // is no longer used — kept as a stub in case a code path still references it.
    async function checkDepositWaiting(_senderId: number, rejection: string): Promise<{ status: string; reason: string }> {
      return { status: 'failed', reason: rejection }
    }

    /** natstat: update each queue entry to done/failed based on simulation + submission */
    async function updateQueueStatuses(
      queueEntries: Array<{ id: number; payload: any }>,
      simulatedGood: Array<{ senderId: number; cawonce: number }>,
      simulationRejections: string[]
    ) {
console.log("Update success")
      const succeededKeys = new Set(
        simulatedGood.map(a => `${a.senderId}-${a.cawonce}`)
      )
console.log("succeededKeys", succeededKeys)

      await Promise.all(queueEntries.map(async (entry: any, index) => {
        const data = (entry.payload as any).data
        const key  = `${data.senderId}-${data.cawonce}`

        // Check "Cawonce already used" — verify in Action table before
        // marking done. If the Action row hasn't been indexed yet, defer
        // (status: awaiting_indexer) and we'll recheck on the next tick.
        const rejection = simulationRejections[index] || ''
        const cawonceUsed = rejection.includes('Cawonce already used')
        let cawonceResolution: 'done' | 'failed' | 'awaiting_indexer' | null = null
        if (cawonceUsed) {
          cawonceResolution = await resolveCawonceUsed(data, entry.updatedAt)
          if (cawonceResolution === 'failed') {
            console.log(`[Validator] TxQueue ${entry.id}: Cawonce ${data.cawonce} used by DIFFERENT action — marking failed`)
          } else if (cawonceResolution === 'awaiting_indexer') {
            console.log(`[Validator] TxQueue ${entry.id}: Cawonce ${data.cawonce} reported used but Action row not yet indexed — deferring`)
          }
        }

        const processedByOther = cawonceResolution === 'done'

        let newStatus: string = succeededKeys.has(key) || processedByOther
          ? 'done'
          : cawonceResolution === 'awaiting_indexer'
            ? 'awaiting_indexer'
            : 'failed'

        // Get the rejection reason for this specific entry
        let reason: string | undefined =
          newStatus === 'failed' && simulationRejections[index]
            ? (cawonceUsed && !processedByOther ? 'Cawonce already used' : simulationRejections[index])
            : undefined

        // Check if the failure is due to insufficient balance with a pending deposit
        if (newStatus === 'failed' && reason) {
          const depositCheck = await checkDepositWaiting(data.senderId, reason)
          newStatus = depositCheck.status
          reason = depositCheck.reason
        }

        console.log("new status", newStatus, reason ? `with reason: ${reason}` : '')

        if (newStatus === 'failed' && reason) {
          await markTxQueueFailed(entry.id, reason, data.senderId, data)
        } else if (newStatus === 'awaiting_indexer') {
          // Don't surface this to the user as a failure; just bump the row
          // so updatedAt advances and the next pass will see how long
          // we've been waiting.
          await prisma.txQueue.update({
            where: { id: entry.id },
            data: { status: 'awaiting_indexer', reason: 'awaiting Action indexer' },
          })
        } else {
          // 'done' path (or non-terminal states like waiting_for_deposit).
          // No notification needed — the helper is only for terminal failures.
          await prisma.txQueue.update({
            where: { id: entry.id },
            data: { status: newStatus, ...(reason ? { reason } : {}) }
          })
        }

        // Failure cleanup (Caw FAILED, Follow FAILED, Like delete, etc) now
        // lives in markTxQueueFailed -> cleanupOptimisticRows. We only need
        // to handle the success-side transition below.
        if (newStatus === 'done' && (data.actionType === 0 || data.actionType === 'caw' || data.actionType === 3 || data.actionType === 'recaw')) {
          // If succeeded, mark as SUCCESS
          // Note: Hashtags are processed by ActionProcessor when it receives the on-chain event
          try {
            await prisma.caw.update({
              where: {
                userId_cawonce: {
                  userId: data.senderId,
                  cawonce: data.cawonce
                }
              },
              data: {
                status: 'SUCCESS'
              }
            })
            console.log(`Marked caw as SUCCESS for user ${data.senderId} cawonce ${data.cawonce}`)
          } catch (cawUpdateErr) {
            console.error('Failed to update caw status to SUCCESS:', cawUpdateErr)
            // Continue even if caw update fails (might not exist)
          }
        }
      }))
    }

    function computeTotalTip(
      entries: Array<{ payload: any }>
    ): bigint {
      return entries.reduce((sum, e) => {
        const amounts = (e.payload as any).data.amounts as string[]
        const lastAmt = amounts[amounts.length - 1] ?? '0'
        return sum + BigInt(lastAmt)
      }, BigInt(0))
    }

    /**
     * Recalculate quote for a specific set of actions
     * Used after filtering to succeeded actions to get accurate fees
     */
    async function recalculateQuoteForActions(
      multiData: { actions: any[]; v: number[]; r: string[]; s: string[]; packedActions: string; packedSigs: string }
    ): Promise<{ nativeFee: bigint; withdrawFee: bigint; withdrawLzTokenAmount: bigint }> {
      // Get withdrawal quote
      const withdraws = multiData.actions.filter((action: any) => getActionType(action.actionType).toString() === 'WITHDRAW')
      let withdrawQuote = { nativeFee: BigInt(0), lzTokenFee: BigInt(0) }
      if (withdraws.length > 0) {
        const tokenIds = withdraws.map((action: any) => action.senderId)
        const amounts = withdraws.map((action: any) => BigInt(action.amounts[0]) * 10n**18n)
        try {
          withdrawQuote = await cawActions.withdrawQuote(tokenIds, amounts, false) as any
        } catch (err) {
          console.error("[Validator] Failed to get withdraw quote:", err)
        }
      }

      return {
        nativeFee: BigInt(withdrawQuote.nativeFee || 0),
        withdrawFee: BigInt(withdrawQuote.nativeFee || 0),
        withdrawLzTokenAmount: BigInt(withdrawQuote.lzTokenFee || 0),
      }
    }

    /** natstat: check if OTHER actions have sufficient CAW payment for their content */
    async function validateOtherActionCost(
      action: any
    ): Promise<{ valid: boolean; requiredCaw?: number; underpriced?: boolean }> {
      // Check if this is an 'other' action type
      if (getActionType(action.actionType).toString() !== 'OTHER') {
        return { valid: true }
      }

      const text = action.text || ''

      // Check if this is a profile update (p: prefix or profile-update: prefix)
      if (text.startsWith('p:') || text.startsWith('profile-update:')) {
        // Profile updates have their cost calculated on frontend
        // We just need to check if sufficient tip was provided
        const amounts = action.amounts || []
        const providedTip = amounts.length > 0 ? Number(amounts[0]) : 0

        // Profile updates should have some tip amount for the cost
        if (providedTip < 100) { // Minimum 100 CAW for profile updates
          console.log(`Profile update has insufficient tip: ${providedTip} CAW`)
          return { valid: false, requiredCaw: 100, underpriced: true }
        }
        return { valid: true }
      }

      return { valid: true }
    }


    /** natstat: core polling loop */
    async function pollLoop() {
      await refreshSettings(checkInterval)
      try {
        const entries = await fetchPendingQueue()
        if (!entries.length) return

        // Priority lane: if any queued action has a tip >= priorityTip, skip the batch wait
        // and process immediately. This rewards users who tip generously with faster inclusion.
        const hasPriority = entries.some(e => {
          const action = (e.payload as any)?.data
          return action && isPriorityAction(action)
        })

        // Batch accumulation: wait for more actions unless the oldest has been waiting too long
        // OR a priority action is in the queue
        const { minActionsPerBatch, maxWaitTime } = liveSettings
        if (!hasPriority && entries.length < minActionsPerBatch) {
          const oldestAge = Date.now() - new Date(entries[0].createdAt).getTime()
          if (oldestAge < maxWaitTime) {
            console.log(`[Validator] Waiting for more actions: ${entries.length}/${minActionsPerBatch} (oldest: ${Math.round(oldestAge / 1000)}s / ${Math.round(maxWaitTime / 1000)}s max)`)
            return
          }
          console.log(`[Validator] Max wait time reached (${Math.round(oldestAge / 1000)}s), submitting ${entries.length} action(s)`)
        }

        if (hasPriority) {
          console.log(`[Validator] Priority action detected — skipping batch wait, processing immediately`)
        }

        console.log(`\n========== [Validator] NEW POLL CYCLE ==========`)
        console.log(`[Validator] Processing ${entries.length} pending transactions`)
        console.log(`[Validator] Queue IDs: ${entries.map(e => e.id).join(', ')}`)

        // Immediately mark entries as 'processing' to prevent duplicate pickup by next poll
        await prisma.txQueue.updateMany({
          where: { id: { in: entries.map(e => e.id) } },
          data: { status: 'processing' }
        })
        console.log(`[Validator] Marked ${entries.length} entries as 'processing'`)

        // Log transaction details for debugging
        entries.forEach(entry => {
          const action = (entry.payload as any).data
          console.log(`[Validator] TxQueue #${entry.id}:`)
          console.log(`  - Type: ${getActionType(action.actionType)}`)
          console.log(`  - Sender ID: ${action.senderId}`)
          console.log(`  - Receiver ID: ${action.receiverId}`)
          console.log(`  - Cawonce: ${action.cawonce}`)
          console.log(`  - Status: ${entry.status}`)
          console.log(`  - Created: ${entry.createdAt}`)
        })

        // Pre-filter entries that don't have sufficient CAW for OTHER actions or insufficient tip
        const validatedEntries: typeof entries = []
        const underpricedEntries: Array<{ entry: typeof entries[0]; reason: string }> = []

        for (const entry of entries) {
          const action = (entry.payload as any).data

          // First, check if this is an OTHER action with insufficient CAW for content
          const otherValidation = await validateOtherActionCost(action)
          if (!otherValidation.valid && otherValidation.underpriced) {
            underpricedEntries.push({
              entry,
              reason: `Insufficient CAW for content: required ${otherValidation.requiredCaw} CAW`
            })
            console.log(`[Validator] Marking txQueue entry ${entry.id} as underpriced (content): required ${otherValidation.requiredCaw} CAW`)
            continue
          }

          // Then, validate the tip is sufficient for replication costs
          const tipValidation = await validateActionTip(action)
          if (!tipValidation.valid) {
            underpricedEntries.push({
              entry,
              reason: tipValidation.reason || 'Insufficient tip'
            })
            console.log(`[Validator] Marking txQueue entry ${entry.id} as underpriced (tip): ${tipValidation.reason}`)
            continue
          }

          validatedEntries.push(entry)
        }

        // Mark underpriced entries with 'underpriced' status for potential relay to other validators
        if (underpricedEntries.length > 0) {
          await Promise.all(underpricedEntries.map(({ entry, reason }) => {
            return prisma.txQueue.update({
              where: { id: entry.id },
              data: {
                status: 'underpriced',
                reason
              }
            })
          }))
        }

        // If no valid entries remain, return
        if (!validatedEntries.length) {
          console.log("[Validator] No valid entries to process after filtering")
          return
        }

        // All actions in a batch must belong to the same client (enforced by CawActions.sol).
        // If we have multiple clients, split into per-client batches and process each separately.
        const allActions = validatedEntries.map(e => (e.payload as any).data)
        const uniqueClientIds = getUniqueClientIds(allActions)
        if (uniqueClientIds.length > 1) {
          console.log(`[Validator] Batch has ${uniqueClientIds.length} unique clients, splitting into per-client batches`)

          const clientGroups = groupActionsByClient(allActions)

          for (const [clientId, indices] of clientGroups.entries()) {
            const subBatchEntries = indices.map(idx => validatedEntries[idx])
            console.log(`[Validator] Processing client ${clientId}: ${subBatchEntries.length} entries`)

            const subBatch = buildMultiActionData(subBatchEntries)

            try {
              const simResult = await simulateActions(validatorId, subBatch)
              if (!simResult || !simResult.successfulActions?.length) {
                console.log(`[Validator] Client ${clientId} simulation failed or no successful actions`)
                await Promise.all(subBatchEntries.map(async (entry: any, idx) => {
                  const data = (entry.payload as any).data
                  const rejection = simResult?.rejectionMessages?.[idx] || ''
                  const cawonceUsed = rejection.includes('Cawonce already used')
                  let cawonceResolution: 'done' | 'failed' | 'awaiting_indexer' | null = null
                  if (cawonceUsed) {
                    cawonceResolution = await resolveCawonceUsed(data, entry.updatedAt)
                  }
                  const processedByOther = cawonceResolution === 'done'

                  let failStatus: string = processedByOther
                    ? 'done'
                    : cawonceResolution === 'awaiting_indexer'
                      ? 'awaiting_indexer'
                      : 'failed'
                  let failReason: string | null = processedByOther
                    ? null
                    : cawonceResolution === 'awaiting_indexer'
                      ? 'awaiting Action indexer'
                      : (cawonceUsed ? 'Cawonce already used' : (rejection || 'Simulation failed'))
                  if (failStatus === 'failed' && failReason) {
                    const depositCheck = await checkDepositWaiting(data.senderId, failReason)
                    failStatus = depositCheck.status
                    failReason = depositCheck.reason
                  }
                  if (processedByOther) {
                    await prisma.txQueue.update({
                      where: { id: entry.id },
                      data: { status: 'done', reason: null }
                    })
                  } else if (failStatus === 'failed' && failReason) {
                    await markTxQueueFailed(entry.id, failReason, data.senderId, data)
                  } else {
                    // awaiting_indexer or waiting_for_deposit
                    await prisma.txQueue.update({
                      where: { id: entry.id },
                      data: { status: failStatus, reason: failReason }
                    })
                  }
                }))
                continue
              }

              const succeededKeys = new Set(
                simResult.successfulActions.map((a: any) => `${a.senderId}-${a.cawonce}`)
              )
              const succeededSubEntries = subBatchEntries.filter(e => {
                const data = (e.payload as any).data
                return succeededKeys.has(`${data.senderId}-${data.cawonce}`)
              })

              if (succeededSubEntries.length === 0) continue

              const succeededData = buildMultiActionData(succeededSubEntries)
              const subQuote = await recalculateQuoteForActions(succeededData)
              const gasLimit = await estimateGasLimit(validatorId, succeededData, subQuote)

              // Capture wait time before submission (not after confirmation)
              const subPreSubmitTime = Date.now()
              const subAvgWait = succeededSubEntries.reduce((s, e) => s + (subPreSubmitTime - new Date(e.createdAt).getTime()), 0) / succeededSubEntries.length

              const { processed: finalized, receipt: subReceipt } = await submitProcessActions(validatorId, succeededData, subQuote, gasLimit)
              console.log(`[Validator] Client ${clientId}: ${finalized.length} actions finalized`)

              // Record analytics
              if (subReceipt) {
                const subTipCaw = computeTotalTip(succeededSubEntries)
                try {
                  const subFee = subReceipt.fee ?? (subReceipt.gasUsed * (subReceipt.gasPrice ?? 0n))
                  await prisma.validatorTx.create({ data: {
                    txHash: subReceipt.hash,
                    blockNumber: BigInt(subReceipt.blockNumber),
                    actionCount: finalized.length,
                    actionBreakdown: buildActionBreakdown(succeededData.actions),
                    gasUsed: subReceipt.gasUsed.toString(),
                    gasPrice: subFee > 0n ? (subFee / subReceipt.gasUsed).toString() : '0',
                    ethCost: subFee.toString(),
                    tipCaw: subTipCaw.toString(),
                    tipEthValue: '0', // Not calculated in sub-batch path
                    profit: (0n - subFee).toString(),
                    validatorId,
                    avgWaitMs: Math.round(subAvgWait),
                  }})
                } catch (e: any) { console.error('[Analytics] ❌ Failed to record ValidatorTx:', e.message, e.stack) }
              }

              const finalizedKeys = new Set(finalized.map((f: any) => `${f.senderId}-${f.cawonce}`))
              await Promise.all(subBatchEntries.map(async (entry, idx) => {
                const data = (entry.payload as any).data
                const key = `${data.senderId}-${data.cawonce}`
                const succeeded = finalizedKeys.has(key)
                if (succeeded) {
                  await prisma.txQueue.update({
                    where: { id: entry.id },
                    data: { status: 'done', reason: null }
                  })
                } else {
                  const failReason = simResult.rejectionMessages?.[idx] || 'Transaction failed'
                  await markTxQueueFailed(entry.id, failReason, data.senderId, data)
                }
              }))
            } catch (err: any) {
              console.error(`[Validator] Client ${clientId} batch failed:`, err.message)
              await Promise.all(subBatchEntries.map(async (entry) => {
                const data = (entry.payload as any).data
                await markTxQueueFailed(entry.id, err.message, data.senderId, data)
              }))
            }
          }

          return
        }

        console.log(`[Validator] ${validatedEntries.length} valid entries to simulate`)
        const fullBatch = buildMultiActionData(validatedEntries)
        const totalTipBefore = computeTotalTip(validatedEntries)

        console.log(`[Validator] Starting simulation for validator ${validatorId} with RPC: ${l2RpcUrl}`);
        console.log(`[Validator] Simulating ${fullBatch.actions.length} actions:`, fullBatch.actions.map((a: any) => ({
          type: getActionType(a.actionType).toString(),
          sender: a.senderId,
          receiver: a.receiverId,
          cawonce: a.cawonce,
          amounts: a.amounts?.map((amt: any) => amt.toString())
        })))

        // 1) simulate
        const simulationResult = await simulateActions(validatorId, fullBatch)
        console.log(`[Validator] Simulation completed. Result:`, simulationResult ? 'RECEIVED' : 'NULL/UNDEFINED')

      // Check if simulateActions returned undefined (error case)
      if (!simulationResult) {
        console.error("[Validator] Simulation returned undefined, marking all as failed")
        const reason = 'Simulation failed - internal error'
        await Promise.all(validatedEntries.map(async (entry) => {
          const data = (entry.payload as any).data
          await markTxQueueFailed(entry.id, reason, data.senderId, data)
        }))
        return
      }

      const { successfulActions, rejectionMessages, quote } = simulationResult as any
      console.log("[Validator] Extracted simulation results:")
      console.log("  - successfulActions:", successfulActions)
      console.log("  - successfulActions.length:", successfulActions?.length)
      console.log("  - rejectionMessages:", rejectionMessages)
      console.log("  - rejectionMessages.length:", rejectionMessages?.length)
      console.log("  - quote.nativeFee:", quote?.nativeFee?.toString())
      console.log(successfulActions, '////////////////', validatedEntries);

      console.log("Simulation complete:", successfulActions.length, rejectionMessages)

      if (!successfulActions || !successfulActions.length) {
        console.log("No successful actions from simulation")

        // Check if any rejection is due to RPC/network issues (temporary) vs actual failures (permanent)
        // Check if all rejections are "Cawonce already used"
        // This could mean: (a) another validator processed THIS action, or
        // (b) a DIFFERENT action used this cawonce and the local counter is stale.
        // We check the Action table to distinguish the two cases.
        const allCawonceUsed = rejectionMessages.every((msg: string) =>
          msg?.includes('Cawonce already used')
        )
        if (allCawonceUsed) {
          console.log("[Validator] All actions rejected with 'Cawonce already used' — checking Action table...")
          await Promise.all(validatedEntries.map(async (entry: any) => {
            const data = (entry.payload as any).data
            const resolution = await resolveCawonceUsed(data, entry.updatedAt)
            if (resolution === 'done') {
              console.log(`[Validator] TxQueue ${entry.id}: Same action exists for senderId=${data.senderId} cawonce=${data.cawonce} — marking done`)
              await prisma.txQueue.update({ where: { id: entry.id }, data: { status: 'done' } })
            } else if (resolution === 'failed') {
              console.log(`[Validator] TxQueue ${entry.id}: Cawonce ${data.cawonce} used by DIFFERENT action (or indexer timeout) — marking failed`)
              await markTxQueueFailed(entry.id, 'Cawonce already used', data.senderId, data)
            } else {
              // awaiting_indexer — Action row not yet present. Defer to next tick.
              console.log(`[Validator] TxQueue ${entry.id}: Cawonce ${data.cawonce} reported used but Action row not yet indexed — deferring`)
              await prisma.txQueue.update({
                where: { id: entry.id },
                data: { status: 'awaiting_indexer', reason: 'awaiting Action indexer' },
              })
            }
          }))
          return
        }

        const hasTemporaryError = rejectionMessages.some((msg: string) => {
          const lowerMsg = msg?.toLowerCase() || ''
          return lowerMsg.includes('timeout') ||
                 lowerMsg.includes('network') ||
                 lowerMsg.includes('connection') ||
                 lowerMsg.includes('rpc') ||
                 lowerMsg.includes('will retry') ||
                 lowerMsg.includes('too many requests') ||
                 lowerMsg.includes('429') ||
                 lowerMsg.includes('rate limit') ||
                 lowerMsg.includes('missing response') ||
                 // Auth state hasn't been relayed from L1 to L2 yet — the
                 // user just submitted the authenticate tx and we're waiting
                 // on LayerZero (typically 1-5 min). Same race the pre-sim
                 // pendingDepositTxHash hold handles for deposits, but that
                 // gate doesn't fire here because there's no tx hash on the
                 // queued action. Retry on next poll until L2 catches up.
                 lowerMsg.includes('not authenticated with this client')
        })

        if (hasTemporaryError) {
          console.log("========== [Validator] TEMPORARY ERROR DETECTED ==========")
          console.log("  Keeping transactions as PENDING for automatic retry")
          console.log("  Affected TxQueue IDs:", validatedEntries.map(e => e.id).join(', '))
          console.log("  Rejection messages:", rejectionMessages)
          console.log("  These will be retried on next poll cycle")
          console.log("==========================================================")
          // For network errors, just keep them as pending - validator will retry automatically
          // Don't mark as failed, as the network might recover
          return
        } else {
          console.log("========== [Validator] PERMANENT FAILURE DETECTED ==========")
          console.log("  Marking transactions as FAILED")
          console.log("  Affected TxQueue IDs:", validatedEntries.map(e => e.id).join(', '))
          // Mark ALL entries as failed with their specific rejection messages
          await Promise.all(validatedEntries.map(async (entry, index) => {
            const data = (entry.payload as any).data

            // Mark Caw as FAILED if this is a caw or recaw action
            // Caw / Follow / Like / Tip row cleanup is now handled inside
            // markTxQueueFailed -> cleanupOptimisticRows. No per-site cleanup
            // needed here.

            const reason = rejectionMessages[index] || 'Simulation rejected - unknown reason'
            await markTxQueueFailed(entry.id, reason, data.senderId, data)
          }))
        }
        return
      }




      // build a Set of senderId-cawonce keys for those that passed sim:
      const succeededKeys = new Set(
        successfulActions.map((a: any) => `${a.senderId}-${a.cawonce}`)
      )

      // Check if we're on testnet
      const network = await provider.getNetwork()
      const isTestnet = Number(network.chainId) === BASE_SEPOLIA_CHAIN_ID

      if (isTestnet) {
        console.log('[Validator] Running on testnet (Base Sepolia) - gas cost will be scaled down')
      }

      // filter down to only those queue-rows that actually succeeded
      console.log("[Validator] Filtering succeeded entries from", validatedEntries.length, "total entries")
      console.log("[Validator] Rejection messages:", rejectionMessages.map((msg: string, i: number) => `[${i}]: ${msg || '(empty - success)'}`))

      const succeededEntries = validatedEntries.filter((e, index) => {
        const success = rejectionMessages[index] == '';
        const action = (e.payload as any).data
        console.log(`[Validator] Entry ${e.id} (${getActionType(action.actionType)}): ${success ? 'PASSED' : 'REJECTED: ' + rejectionMessages[index]}`)
        return success
      })

      console.log(`[Validator] ${succeededEntries.length} entries passed simulation (out of ${validatedEntries.length})`)

      if (succeededEntries.length === 0) {
        console.log("[Validator] No entries passed simulation - all rejected. Not submitting transaction.")
        // The rejections will be handled in the next section
      }

      // rebuild your call data only with the succeeded entries
      const multiSucceeded = buildMultiActionData(succeededEntries)
      console.log("LENGH", multiSucceeded.actions.length)
      console.log("ready to roll:", multiSucceeded.actions.length)



      // Recalculate quote for the succeeded actions only (may have different clients)
      // This ensures we only pay for replication of successful actions
      const succeededQuote = await recalculateQuoteForActions(multiSucceeded)

      // 2) estimate gas cost
      console.log("[Validator] Estimating gas cost...")
      const gasCost = await estimateProcessGasCost(
        validatorId, multiSucceeded, succeededQuote
      )
      console.log("[Validator] Estimated gas cost:", gasCost.toString(), "wei")

      console.log("[Validator] Estimating gas limit...")
      const rawGasLimit = await estimateGasLimit(
        validatorId, multiSucceeded, succeededQuote
      );
      console.log("[Validator] Estimated gas limit:", rawGasLimit.toString())

      // recompute tip from only the successful ones
      const totalTipCaw = computeTotalTip(succeededEntries)

      // Convert CAW tip to ETH using Uniswap getAmountsOut
      console.log(`[Validator] Converting ${totalTipCaw} CAW to ETH via Uniswap...`)
      const tipInWei = await cawToEth(totalTipCaw, ethMainnetRpcUrl)

      // On testnet, scale down gas cost to simulate mainnet economics
      // (testnet gas is essentially free, but we want the check to still work)
      const effectiveGasCost = isTestnet ? gasCost / TESTNET_GAS_SCALE_FACTOR : gasCost

      console.log(`[Validator] Tip calculation:`)
      console.log(`  - Total tip: ${totalTipCaw} CAW`)
      console.log(`  - Tip value: ${tipInWei.toString()} wei (${Number(tipInWei) / 1e18} ETH)`)
      console.log(`  - Raw gas cost: ${gasCost.toString()} wei`)
      if (isTestnet) {
        console.log(`  - Scaled gas cost (testnet): ${effectiveGasCost.toString()} wei (÷${TESTNET_GAS_SCALE_FACTOR})`)
      }
      console.log(`  - Tip >= Gas cost? ${tipInWei >= effectiveGasCost}`)

      // Check if tip covers gas cost
      if (tipInWei < effectiveGasCost) {
        console.log("[Validator] ❌ SKIPPING - Tip is less than gas cost!")
        console.log(`[Validator] ========== GAS COST FAILURE DETAILS ==========`)
        console.log(`[Validator]   Network:            ${isTestnet ? 'Base Sepolia (testnet)' : 'Base Mainnet'}`)
        console.log(`[Validator]   Raw gas cost (wei): ${gasCost.toString()}`)
        if (isTestnet) {
          console.log(`[Validator]   Scale factor:       ÷${TESTNET_GAS_SCALE_FACTOR}`)
        }
        console.log(`[Validator]   Effective gas cost: ${effectiveGasCost.toString()} wei`)
        console.log(`[Validator]   Tip provided (CAW): ${totalTipCaw.toString()}`)
        console.log(`[Validator]   Tip value (wei):    ${tipInWei.toString()}`)
        console.log(`[Validator]   Tip value (ETH):    ${Number(tipInWei) / 1e18}`)
        console.log(`[Validator]   Shortfall (wei):    ${(effectiveGasCost - tipInWei).toString()}`)
        // Log each action's amounts
        succeededEntries.forEach((entry, i) => {
          const action = (entry.payload as any).data
          console.log(`[Validator]   Action ${i} (${getActionType(action.actionType)}): amounts = [${action.amounts?.join(', ') || 'none'}]`)
        })
        console.log(`[Validator] ==============================================`)
        // Mark all entries as failed due to insufficient tip
        const failReason = `Insufficient tip: ${totalTipCaw} CAW (${Number(tipInWei) / 1e18} ETH) < gas cost ${Number(effectiveGasCost) / 1e18} ETH`
        await updateQueueStatuses(entries, [],
          entries.map(() => failReason))
        return
      }

      console.log(`[Validator] ✅ Tip check passed${isTestnet ? ' (testnet scaled)' : ''} - proceeding with submission`)

      console.log("[Validator] Submitting transaction with", multiSucceeded.actions.length, "actions")
      console.log("[Validator] Actions to submit:", multiSucceeded.actions.map((a: any) => ({
        type: getActionType(a.actionType).toString(),
        sender: a.senderId,
        receiver: a.receiverId,
        cawonce: a.cawonce
      })))

      let finalized: any[] = [];
      let submissionError: string | null = null;

      try {
        console.log("[Validator] ========== SUBMITTING TRANSACTION TO BLOCKCHAIN ==========")
        // Capture wait time before submission (not after confirmation, which adds block time)
        const preSubmitTime = Date.now()
        const avgWait = succeededEntries.reduce((s: number, e: any) => s + (preSubmitTime - new Date(e.createdAt).getTime()), 0) / succeededEntries.length
        const submitResult = await submitProcessActions(
           validatorId, multiSucceeded, succeededQuote, rawGasLimit
         )
        finalized = submitResult.processed
        const txReceipt = submitResult.receipt
        console.log(`[Validator] ✓ ${finalized.length} action(s) finalized on chain`)

        // Record analytics
        if (txReceipt) {
          try {
            const txFee = txReceipt.fee ?? (txReceipt.gasUsed * (txReceipt.gasPrice ?? 0n))
            await prisma.validatorTx.create({ data: {
              txHash: txReceipt.hash,
              blockNumber: BigInt(txReceipt.blockNumber),
              actionCount: finalized.length,
              actionBreakdown: buildActionBreakdown(multiSucceeded.actions),
              gasUsed: txReceipt.gasUsed.toString(),
              gasPrice: txFee > 0n ? (txFee / txReceipt.gasUsed).toString() : '0',
              ethCost: txFee.toString(),
              tipCaw: totalTipCaw.toString(),
              tipEthValue: tipInWei.toString(),
              profit: (tipInWei - txFee).toString(),
              validatorId,
              avgWaitMs: Math.round(avgWait),
            }})
          } catch (e: any) { console.error('[Analytics] ❌ Failed to record ValidatorTx:', e.message, e.stack) }
        }

      } catch (submitErr: any) {
        console.error("[Validator] ========== TRANSACTION SUBMISSION FAILED ==========")
        console.error("[Validator] Full error object:", submitErr)
        console.error("[Validator] Error message:", submitErr.message)
        console.error("[Validator] Error code:", submitErr.code)
        console.error("[Validator] Error stack:", submitErr.stack)

        // Check if this is a provider/network/rate-limit error that should be retried
        const errMsg = (submitErr.message || '').toLowerCase()
        const isTransient =
          submitErr.code === 'UNSUPPORTED_OPERATION' ||
          submitErr.code === 'BAD_DATA' ||
          submitErr.code === 'UNKNOWN_ERROR' ||
          errMsg.includes('provider destroyed') ||
          errMsg.includes('cancelled request') ||
          errMsg.includes('too many requests') ||
          errMsg.includes('429') ||
          errMsg.includes('rate limit') ||
          errMsg.includes('missing response') ||
          errMsg.includes('internal error') ||
          errMsg.includes('could not coalesce') ||
          errMsg.includes('timeout') ||
          errMsg.includes('enotfound') ||
          errMsg.includes('econnrefused') ||
          errMsg.includes('econnreset')
        if (isTransient) {
          console.log('[Validator] Transient error during submission — keeping entries pending for retry:', errMsg.slice(0, 150))
          await initializeConnection()
          return
        }

        submissionError = submitErr.message || 'Failed to submit transaction'
        // finalized remains empty array, all submitted entries will be marked as failed
      }

      // 4) update database - properly track which entries succeeded vs failed
      // Build array to track success/failure for each original entry
      const finalStatuses = validatedEntries.map((entry, index) => {
        // Check if this entry was in the succeeded set that got submitted
        const wasSubmitted = succeededEntries.includes(entry)
        if (!wasSubmitted) {
          // This entry failed simulation
          // The rejection message for this specific entry is at rejectionMessages[index]
          return { succeeded: false, reason: rejectionMessages[index] || 'Simulation failed' }
        }
        // This entry was submitted
        if (submissionError) {
          // Transaction submission threw an error (e.g., reverted)
          return { succeeded: false, reason: submissionError }
        }
        // Check if it finalized successfully
        const data = (entry.payload as any).data
        const isFinalized = finalized.some(
          f => f.senderId === data.senderId && f.cawonce === data.cawonce
        )
        return {
          succeeded: isFinalized,
          reason: isFinalized ? null : 'Transaction failed on chain'
        }
      })

      // Update each entry with its actual status. Logs only anomalies
      // (failures, already-done skips) per-row; the summary at the end
      // reports the success count.
      let txSuccess = 0
      let txFailed = 0
      await Promise.all(validatedEntries.map(async (entry, index) => {
        const { succeeded, reason } = finalStatuses[index]
        const data = (entry.payload as any).data

        if (!succeeded) {
          const currentEntry = await prisma.txQueue.findUnique({
            where: { id: entry.id },
            select: { status: true }
          })
          if (currentEntry?.status === 'done') {
            // Another path already marked this done — nothing to do, quiet skip.
            return
          }
        }

        if (succeeded) {
          await prisma.txQueue.update({
            where: { id: entry.id },
            data: { status: 'done', reason: null }
          })
          // Increment the session key's locally-tracked spent counter so the
          // /api/actions fast-path spend-limit check stays accurate without
          // a live sessionSpent() RPC call per submission.
          await incrementSessionSpent(prisma as any, entry.payload as any, entry.signedTx)
          txSuccess++
        } else {
          await markTxQueueFailed(entry.id, reason || 'Transaction failed', data.senderId, data)
          txFailed++
          console.warn(`[Validator] TxQueue #${entry.id} (${getActionType(data.actionType)} from ${data.senderId}) FAILED: ${reason || 'unknown'}`)
        }
      }))
      if (txFailed > 0) {
        console.log(`[Validator] TxQueue updated: ${txSuccess} success, ${txFailed} failed`)
      }

      // Update caw status for CAW actions that were processed. Like the
      // TxQueue loop above: log only anomalies (failures), not successes.
      await Promise.all(validatedEntries.map(async (entry, index) => {
        const { succeeded, reason } = finalStatuses[index]
        const data = (entry.payload as any).data

        // Check if this is a CAW action
        if (data.actionType === 0 || data.actionType === 'caw') {
          if (succeeded) {
            try {
              await prisma.caw.update({
                where: {
                  userId_cawonce: {
                    userId: data.senderId,
                    cawonce: data.cawonce
                  }
                },
                data: { status: 'SUCCESS' }
              })
            } catch (cawUpdateErr) {
              console.error(`Failed to mark caw SUCCESS (user ${data.senderId} cawonce ${data.cawonce}):`, cawUpdateErr)
            }
          } else {
            // Before marking as FAILED, check if it's already SUCCESS
            try {
              const existingCaw = await prisma.caw.findUnique({
                where: {
                  userId_cawonce: {
                    userId: data.senderId,
                    cawonce: data.cawonce
                  }
                },
                select: { status: true }
              })

              if (existingCaw && existingCaw.status !== 'SUCCESS') {
                await prisma.caw.update({
                  where: {
                    userId_cawonce: {
                      userId: data.senderId,
                      cawonce: data.cawonce
                    }
                  },
                  data: {
                    status: 'FAILED',
                    reason: reason || 'Transaction failed'
                  }
                })
                console.log(`[Validator] Marked caw FAILED (user ${data.senderId} cawonce ${data.cawonce}): ${reason}`)
              }
              // If existingCaw?.status === 'SUCCESS', another path already
              // confirmed it — quiet no-op.
            } catch (cawUpdateErr) {
              console.error('Failed to mark caw FAILED:', cawUpdateErr)
            }
          }
        }

        // Check if this is a WITHDRAW action (actionType: 6)
        if (data.actionType === 6 || data.actionType === 'WITHDRAW') {
          if (succeeded) {
            // Mark withdrawal request as completed
            try {
              const withdrawalRequest = await prisma.withdrawalRequest.findFirst({
                where: {
                  userId: data.senderId,
                  cawonce: data.cawonce
                }
              })

              if (withdrawalRequest) {
                await prisma.withdrawalRequest.update({
                  where: { id: withdrawalRequest.id },
                  data: {
                    status: 'completed',
                    completedAt: new Date()
                  }
                })
                console.log(`[ValidatorService] Marked withdrawal request as completed for user ${data.senderId} cawonce ${data.cawonce}`)
              } else {
                console.warn(`[ValidatorService] No withdrawal request found for user ${data.senderId} cawonce ${data.cawonce}`)
              }
            } catch (withdrawalUpdateErr) {
              console.error('[ValidatorService] Failed to update withdrawal request status:', withdrawalUpdateErr)
              // Continue even if withdrawal update fails
            }
          } else {
            // Mark withdrawal request as failed
            try {
              const withdrawalRequest = await prisma.withdrawalRequest.findFirst({
                where: {
                  userId: data.senderId,
                  cawonce: data.cawonce
                }
              })

              if (withdrawalRequest) {
                await prisma.withdrawalRequest.update({
                  where: { id: withdrawalRequest.id },
                  data: {
                    status: 'failed'
                  }
                })
                console.log(`[ValidatorService] Marked withdrawal request as failed for user ${data.senderId} cawonce ${data.cawonce}: ${reason}`)
              }
            } catch (withdrawalUpdateErr) {
              console.error('[ValidatorService] Failed to update withdrawal request status to failed:', withdrawalUpdateErr)
              // Continue even if withdrawal update fails
            }
          }
        }

      }))
      } catch (err: any) {
        console.error("[Validator] Poll loop error:", {
          message: err.message,
          stack: err.stack,
          rpcUrl: l2RpcUrl
        })
        // Don't crash on errors, will retry on next interval
      }
    }

    /**
     * Decode known custom error selectors into human-readable strings.
     * Add new entries as we hit them so future failures are diagnosable
     * without grepping ABIs by hand.
     *
     * Returns null if the data isn't a recognized custom error.
     */
    function decodeCustomError(data: string | undefined | null): string | null {
      if (!data || typeof data !== 'string' || !data.startsWith('0x') || data.length < 10) return null
      const selector = data.slice(0, 10).toLowerCase()
      const body = '0x' + data.slice(10)

      const fmtEth = (wei: bigint): string => {
        const n = Number(wei) / 1e18
        if (n === 0) return '0 ETH'
        if (n >= 0.001) return `${n.toFixed(6)} ETH`
        return `${n.toExponential(3)} ETH (${wei} wei)`
      }

      try {
        const coder = new AbiCoder()

        // LZ_InsufficientFee(uint256 requiredNative, uint256 suppliedNative,
        //                    uint256 requiredLzToken, uint256 suppliedLzToken)
        if (selector === '0x4f3ec0d3') {
          const [reqN, supN, reqL, supL] = coder.decode(['uint256', 'uint256', 'uint256', 'uint256'], body)
          const reqNb = BigInt(reqN), supNb = BigInt(supN)
          const shortBy = reqNb > supNb ? reqNb - supNb : 0n
          const pct = reqNb > 0n ? Number(shortBy * 10000n / reqNb) / 100 : 0
          return `LZ_InsufficientFee — required ${fmtEth(reqNb)}, supplied ${fmtEth(supNb)}` +
                 (shortBy > 0n ? ` (short by ${fmtEth(shortBy)} ≈ ${pct}%; bump LZ fee buffer)` : ` (LZ token: req=${reqL}, sup=${supL})`)
        }

        // LZ_MessageLib_InvalidMessageSize(uint256 actual, uint256 max)
        if (selector === '0xc667af3e') {
          const [actual, max] = coder.decode(['uint256', 'uint256'], body)
          return `LZ_InvalidMessageSize — payload ${actual} bytes exceeds limit ${max} bytes (raise maxMessageSize via setConfig)`
        }

        // OnlyOwner / generic Ownable
        if (selector === '0x82b42900') return 'Unauthorized — only owner'
      } catch {
        // Decoder failed — fall through to return null
      }
      return null
    }

    function formatRpcError(err: any): string {
      // Extract the most useful info from ethers error blobs.
      // Check the most specific signals first — ethers errors can have lots of
      // fields and we want to avoid substring matches on arbitrary message text.

      // 0. Try to decode known custom errors first (LZ_InsufficientFee, etc.)
      const errData = err?.data || err?.error?.data || err?.info?.error?.data
      const decoded = decodeCustomError(errData)
      if (decoded) {
        const txHash = err?.receipt?.hash || err?.transaction?.hash
        return `${decoded}${txHash ? ` — tx: ${txHash}` : ''}`
      }

      // 1. Contract revert (the most common "error" from writes)
      if (err?.code === 'CALL_EXCEPTION') {
        const reason = err.reason || err.revert?.args?.[0]
        const status = err.receipt?.status
        const txHash = err.receipt?.hash || err.transaction?.hash
        if (status === 0 || status === '0') {
          return `Transaction reverted${reason ? `: ${reason}` : ' (no reason)'} — tx: ${txHash}`
        }
        return `Call exception${reason ? `: ${reason}` : ''}`
      }

      // 2. Insufficient funds for gas + value
      if (err?.code === 'INSUFFICIENT_FUNDS' || err?.message?.includes('insufficient funds')) {
        return `Insufficient funds for tx (gas + value)`
      }

      // 3. RPC-level errors (inspect err.info.payload to know which method).
      // ethers wraps RPC errors with error.code from the server (-32xxx).
      const rpcCode = err?.error?.code ?? err?.info?.error?.code
      const rpcMessage = err?.error?.message ?? err?.info?.error?.message
      const method = err?.info?.payload?.method

      if (rpcCode === -32005 || rpcMessage?.includes('Too Many Requests')) {
        return `RPC rate limited on ${method || 'unknown'}`
      }
      if (rpcCode === -32000 && rpcMessage?.includes('oversized data')) {
        return `Oversized transaction data: ${rpcMessage}`
      }
      if (rpcCode === -32000 && rpcMessage?.includes('internal error')) {
        return `RPC internal error on ${method || 'unknown'}: ${rpcMessage}`
      }
      if (rpcCode === -32600 || rpcMessage?.includes('Unauthorized')) {
        return `RPC auth failed — check API key`
      }

      // 4. HTTP-level auth errors (before ethers wraps them)
      if (err?.code === 'SERVER_ERROR' && err?.info?.responseStatus === '401 Unauthorized') {
        return `RPC auth failed (HTTP 401) — check API key`
      }

      // 5. Anything else: full message (truncated)
      const msg = err?.shortMessage || err?.message || String(err)
      return msg.length > 300 ? msg.slice(0, 300) + '...' : msg
    }

    // HTTP provider for replication — created once, reused across cycles.
    // WebSocket can fail on historical tx lookups; HTTP is more reliable
    // for the bulk data fetching the reconstruction needs.
    const replicationHttpRpcUrl = getL2HttpRpcUrl(l2RpcUrl)
    const replicationHttpProvider = makeJsonRpcProvider(replicationHttpRpcUrl, 84532)
    console.log(`[Replication] HTTP RPC: ${replicationHttpRpcUrl.slice(0, 50)}...`)


    // ================================================================
    // Optimistic replication: direct L2b submission with stake + fraud proofs
    // ================================================================

    const OPTIMISTIC_ARCHIVE_ADDRESS = CAW_ACTIONS_ARCHIVE_ADDRESS
    // One-shot guard so the CLI stake-setup prompt prints once per process,
    // not every 30s when the replicator loop re-fires.
    let underStakedWarned = false
    const ethers_formatStake = (wei: bigint) => (Number(wei) / 1e18).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
    const CHALLENGE_RELAY_ADDRESS = CAW_CHALLENGE_RELAY_ADDRESS
    const OPTIMISTIC_MIN_STAKE = BigInt('10000000000000000')     // 0.01 ETH
    const OPTIMISTIC_INITIAL_DEPOSIT = BigInt('20000000000000000') // 0.02 ETH
    const OPTIMISTIC_CHECKPOINT_INTERVAL = 32

    const archiveAbi = [
      'function stakes(address) view returns (uint256)',
      'function pendingCount(address) view returns (uint256)',
      'function deposit() payable',
      'function withdraw(uint256)',
      'function submitReplication(uint32 clientId, uint256 startCheckpointId, uint256 endCheckpointId, bytes packedActions, bytes32[] r, bytes32 merkleRoot, bytes32 entryHash)',
      'function finalizeSubmission(uint256 submissionId)',
      'function checkpointClaimed(uint32, uint256) view returns (uint256)',
      'function isRangeAvailable(uint32 clientId, uint256 start, uint256 end) view returns (bool)',
      'function getSubmission(uint256) view returns (address submitter, bytes32 merkleRoot, uint32 clientId, uint256 startCheckpointId, uint256 endCheckpointId, uint256 finalizedAt, uint8 status)',
      'function nextSubmissionId() view returns (uint256)',
      'event SubmissionCreated(uint256 indexed submissionId, address indexed submitter, uint32 indexed clientId, uint256 startCheckpointId, uint256 endCheckpointId, bytes32 merkleRoot)',
      'event ActionsArchived(uint256 indexed submissionId, uint32 indexed clientId, bytes packedActions, bytes32[] r)',
    ]

    // Lazily initialized L2b provider + contracts (only when optimistic mode is enabled)
    let l2bProvider: JsonRpcProvider | null = null
    let l2bWallet: Wallet | null = null          // SUBMITTER — may be REPLICATOR_PRIVATE_KEY in test mode
    let l2bMonitorWallet: Wallet | null = null   // MONITOR/challenger — always the main validator key
    let archiveRead: Contract | null = null
    let archiveWrite: Contract | null = null     // bound to l2bWallet (submitter)

    // Slash-test knobs. When both are set, submissions fire from a separate
    // wallet (so slashed ETH visibly moves to the main validator who challenges)
    // and deliberately commit a bad merkle root so the monitor can catch them.
    // CORRUPT_REPLICATION and CORRUPT_MODE BOTH must be set — no defaults.
    // Twin-key gate so a single fat-fingered env var can't accidentally
    // start producing fraud (and losing your stake) in production.
    //
    // CORRUPT_MODE choices:
    //   "A": keep packedActions honest but commit a bad merkleRoot.
    //        Caught by monitor's Mode-A branch → slashIncoherentRoot.
    //   "B": corrupt one byte of packedActions and build a root consistent
    //        with that corruption. Caught by monitor's Mode-B branch →
    //        resolveChallenge with submitter's claimedHash + proof.
    const _rawCorruptMode = (process.env.CORRUPT_MODE || '').toUpperCase()
    const CORRUPT_REPLICATION =
      process.env.CORRUPT_REPLICATION === 'true' &&
      (_rawCorruptMode === 'A' || _rawCorruptMode === 'B')
    const CORRUPT_MODE = CORRUPT_REPLICATION ? _rawCorruptMode : ''
    if (process.env.CORRUPT_REPLICATION === 'true' && !CORRUPT_REPLICATION) {
      console.warn(
        `[OptimisticReplication] CORRUPT_REPLICATION=true was set but ` +
        `CORRUPT_MODE is missing/invalid (got "${process.env.CORRUPT_MODE}"). ` +
        `Refusing to corrupt — set CORRUPT_MODE to A or B explicitly to enable.`
      )
    }
    const REPLICATOR_PRIVATE_KEY = process.env.REPLICATOR_PRIVATE_KEY

    function getL2bContracts() {
      if (l2bProvider && l2bWallet && l2bMonitorWallet && archiveRead && archiveWrite) {
        return { l2bProvider, l2bWallet, l2bMonitorWallet, archiveRead, archiveWrite }
      }
      // REPLICATION_RPC + REPLICATION_CHAIN are the canonical names. We
      // accept the legacy RPC_ARBITRUM_SEPOLIA for back-compat with older
      // installs — drop it later once everyone's regenerated their .env.
      const l2bRpcUrl = process.env.REPLICATION_RPC || process.env.RPC_ARBITRUM_SEPOLIA
      if (!l2bRpcUrl) throw new Error('REPLICATION_RPC not set — required for optimistic replication')

      // Map REPLICATION_CHAIN → chainId. Today only Arbitrum Sepolia ships
      // with deployed contracts. When other chains come online, extend this
      // map (and OPTIMISTIC_ARCHIVE_ADDRESS will need to become a per-chain
      // lookup too — see the multi-chain backlog item).
      const chainIdByKey: Record<string, number> = {
        'arbitrum-sepolia': 421614,
        'arbitrum-one': 42161,
      }
      const replicationChain = process.env.REPLICATION_CHAIN || 'arbitrum-sepolia'
      const chainId = chainIdByKey[replicationChain]
      if (!chainId) {
        throw new Error(`REPLICATION_CHAIN="${replicationChain}" — supported keys: ${Object.keys(chainIdByKey).join(', ')}`)
      }

      l2bProvider = makeJsonRpcProvider(l2bRpcUrl, chainId)

      // Submitter uses REPLICATOR_PRIVATE_KEY if present (test mode), else main validator.
      const submitterKey = REPLICATOR_PRIVATE_KEY || privateKey!
      l2bWallet = new Wallet(submitterKey, l2bProvider)
      l2bMonitorWallet = new Wallet(privateKey!, l2bProvider)

      archiveRead = new Contract(OPTIMISTIC_ARCHIVE_ADDRESS, archiveAbi, l2bProvider)
      archiveWrite = new Contract(OPTIMISTIC_ARCHIVE_ADDRESS, archiveAbi, l2bWallet)

      console.log(`[OptimisticReplication] L2b RPC: ${l2bRpcUrl.slice(0, 50)}...`)
      console.log(`[OptimisticReplication] Archive: ${OPTIMISTIC_ARCHIVE_ADDRESS}`)
      console.log(`[OptimisticReplication] Submitter: ${l2bWallet.address}${REPLICATOR_PRIVATE_KEY ? ' (REPLICATOR test key)' : ''}`)
      console.log(`[OptimisticReplication] Monitor:   ${l2bMonitorWallet.address}`)
      if (CORRUPT_REPLICATION) {
        console.warn(`[OptimisticReplication] ⚠️  CORRUPT_REPLICATION=true CORRUPT_MODE=${CORRUPT_MODE} — next submission will be fraudulent`)
      }

      return { l2bProvider, l2bWallet, l2bMonitorWallet, archiveRead, archiveWrite }
    }

    /**
     * Shared helper: reconstruct ordered actions + r values from L2 events
     * for a given client and checkpoint range. Reuses the exact same logic as
     * the existing replicationLoop.
     *
     * Returns null if reconstruction fails (caller should skip/retry).
     */
    async function reconstructCheckpointData(
      clientId: number,
      startCheckpointId: number,
      endCheckpointId: number,
    ): Promise<{
      allActions: any[]
      allR: string[]
      packedBytes: Uint8Array
      checkpointHashes: string[]
      entryHash: string
    } | null> {
      const httpProvider = replicationHttpProvider
      const numCheckpoints = endCheckpointId - startCheckpointId + 1
      const totalActionsNeeded = numCheckpoints * OPTIMISTIC_CHECKPOINT_INTERVAL

      // Read clientActionCount from CawActions to know total actions
      const cawActionsViewAbi = ['function clientActionCount(uint32) view returns (uint256)']
      const cawActionsView = new Contract(CAW_ACTIONS_ADDRESS, cawActionsViewAbi, httpProvider)
      const actionCount = Number(await cawActionsView.clientActionCount(clientId))

      const rangeStartPos = (startCheckpointId - 1) * OPTIMISTIC_CHECKPOINT_INTERVAL
      const actionsNeededFromEnd = actionCount - rangeStartPos
      const latestL2 = await httpProvider.getBlockNumber()
      const eventsContract = new Contract(CAW_ACTIONS_ADDRESS, cawActionsAbi as any, httpProvider)

      const CHUNK = 50_000
      let processedEvents: any[] = []
      let scannedActions = 0
      let toBlock = latestL2

      while (scannedActions < actionsNeededFromEnd) {
        const fromBlock = Math.max(0, toBlock - CHUNK + 1)
        const batch = await eventsContract.queryFilter(
          eventsContract.filters.ActionsProcessed(),
          fromBlock,
          toBlock,
        )
        for (const ev of batch) {
          const args: any = (ev as any).args
          if (!args) continue
          const packedHexEvt = args[0] || args.packedActions || ''
          if (packedHexEvt && typeof packedHexEvt === 'string' && packedHexEvt.length > 4) {
            try {
              const buf = new Uint8Array((packedHexEvt.startsWith('0x') ? packedHexEvt.slice(2) : packedHexEvt).match(/.{2}/g)!.map((b: string) => parseInt(b, 16)))
              const actionsArr = unpackActions(buf)
              for (const a of actionsArr) {
                if (Number(a.clientId) === clientId) scannedActions++
              }
            } catch { /* skip malformed events */ }
          }
        }
        processedEvents = [...batch, ...processedEvents]
        if (fromBlock === 0) break
        toBlock = fromBlock - 1
      }

      const txHashes = Array.from(new Set(processedEvents.map(e => e.transactionHash)))
      if (txHashes.length === 0) return null

      type OrderedEntry = {
        blockNumber: number; txIndex: number; calldataPos: number
        action: any; v: number; r: string; s: string
      }
      const orderedEntries: OrderedEntry[] = []

      for (const txHash of txHashes) {
        const tx = await httpProvider.getTransaction(txHash)
        if (!tx) {
          console.error(`[Reconstruct] Could not fetch tx ${txHash}`)
          return null
        }

        const decoded = packedIface.decodeFunctionData('processActions', tx.data)
        const packedHex: string = decoded[1]
        const sigsHex: string = decoded[2]

        const packedBuf = new Uint8Array((packedHex.startsWith('0x') ? packedHex.slice(2) : packedHex).match(/.{2}/g)!.map(b => parseInt(b, 16)))
        const unpackedActions = unpackActions(packedBuf)

        const sigBytes = new Uint8Array((sigsHex.startsWith('0x') ? sigsHex.slice(2) : sigsHex).match(/.{2}/g)!.map(b => parseInt(b, 16)))

        for (let i = 0; i < unpackedActions.length; i++) {
          const a = unpackedActions[i]
          if (a.clientId !== clientId) continue
          const sigOff = i * 65
          orderedEntries.push({
            blockNumber: tx.blockNumber!,
            txIndex: tx.index!,
            calldataPos: i,
            action: {
              actionType: a.actionType,
              senderId: a.senderId,
              receiverId: a.receiverId,
              receiverCawonce: a.receiverCawonce,
              clientId: a.clientId,
              cawonce: a.cawonce,
              recipients: a.recipients,
              amounts: a.amounts.map((x: any) => BigInt(x)),
              text: a.text,
            },
            v: sigBytes[sigOff],
            r: '0x' + Array.from(sigBytes.slice(sigOff + 1, sigOff + 33)).map(b => b.toString(16).padStart(2, '0')).join(''),
            s: '0x' + Array.from(sigBytes.slice(sigOff + 33, sigOff + 65)).map(b => b.toString(16).padStart(2, '0')).join(''),
          })
        }
      }

      // Sort by (blockNumber, transactionIndex, calldataPosition)
      orderedEntries.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber
        if (a.txIndex !== b.txIndex) return a.txIndex - b.txIndex
        return a.calldataPos - b.calldataPos
      })

      const firstGlobalPos = actionCount - orderedEntries.length
      const localStart = rangeStartPos - firstGlobalPos
      const rangeEntries = orderedEntries.slice(localStart, localStart + totalActionsNeeded)

      if (rangeEntries.length !== totalActionsNeeded) {
        console.error(`[Reconstruct] Only ${rangeEntries.length}/${totalActionsNeeded} actions for checkpoints ${startCheckpointId}..${endCheckpointId}`)
        return null
      }

      const allActions = rangeEntries.map(e => ({
        actionType: Number(e.action.actionType),
        senderId: Number(e.action.senderId),
        receiverId: Number(e.action.receiverId),
        receiverCawonce: Number(e.action.receiverCawonce),
        clientId: Number(e.action.clientId),
        cawonce: Number(e.action.cawonce),
        recipients: Array.from(e.action.recipients).map(Number),
        amounts: Array.from(e.action.amounts).map((a: any) => BigInt(a)),
        text: e.action.text,
      }))
      const allR = rangeEntries.map(e => e.r)

      // Pack the actions
      const packed = packActions(allActions.map(a => ({
        actionType: a.actionType,
        senderId: a.senderId,
        receiverId: a.receiverId,
        receiverCawonce: a.receiverCawonce,
        clientId: a.clientId,
        cawonce: a.cawonce,
        recipients: a.recipients,
        amounts: a.amounts.map((x: any) => BigInt(x)),
        text: a.text,
      })))

      // Verify and compute hash chain per checkpoint
      const hashCheckAbi = ['function clientHashAtCheckpoint(uint32,uint256) view returns (bytes32)']
      const actionsView = new Contract(CAW_ACTIONS_ADDRESS, hashCheckAbi, httpProvider)
      const prevHash = startCheckpointId === 1
        ? '0x' + '00'.repeat(32)
        : await actionsView.clientHashAtCheckpoint(clientId, startCheckpointId - 1)
      const expectedFinalHash = await actionsView.clientHashAtCheckpoint(clientId, endCheckpointId)

      const actionSlices = getPackedActionSlices(packed)
      const checkpointHashes: string[] = []
      let computedHash = prevHash

      for (let i = 0; i < totalActionsNeeded; i++) {
        const actionHash = keccak256(bytesToHex(actionSlices[i]))
        computedHash = keccak256(solidityPacked(['bytes32', 'bytes32', 'bytes32'], [computedHash, allR[i], actionHash]))

        // Record hash at checkpoint boundaries
        if ((i + 1) % OPTIMISTIC_CHECKPOINT_INTERVAL === 0) {
          checkpointHashes.push(computedHash)
        }
      }

      if (computedHash !== expectedFinalHash) {
        console.error(`[Reconstruct] Hash chain mismatch! Computed ${computedHash} vs on-chain ${expectedFinalHash}`)
        return null
      }

      return { allActions, allR, packedBytes: packed, checkpointHashes, entryHash: prevHash }
    }

    /**
     * Optimistic replication loop: submits checkpoint data directly to L2b
     * archive contract with stake-based security instead of LZ fees per batch.
     */
    async function optimisticReplicationLoop() {
      try {
        // Loud reminder every cycle when corruption is active, so this can't
        // silently keep producing fraud after being left on by accident.
        if (CORRUPT_REPLICATION) {
          console.warn(
            `[OptimisticReplication] ⚠️  CORRUPT_REPLICATION=true CORRUPT_MODE=${CORRUPT_MODE} — ` +
            `every submission this cycle will be FRAUDULENT and slashable. ` +
            `Unset both env vars and restart to disable.`
          )
        }
        const { archiveRead: archive, archiveWrite: archiveW, l2bWallet: w } = getL2bContracts()

        // 1. Find clients needing replication FIRST — if none, nothing to do
        //    and we shouldn't prod the operator about stake either.
        //
        //    Per-validator config via REPLICATE_CLIENT_IDS env (comma-separated
        //    list of client IDs this validator replicates). Replaces the old
        //    on-chain CCM replication registry — operators decide independently
        //    which clients they archive, and the chain doesn't need to know.
        const replicateClientIds = (process.env.REPLICATE_CLIENT_IDS || '')
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
          .map(s => Number(s))
          .filter(n => Number.isFinite(n) && n > 0)
        if (replicateClientIds.length === 0) return
        const clients = replicateClientIds.map(id => ({ id }))

        // 2. Check stake. Auto-restake is OFF BY DEFAULT: a stake drop during
        //    live operation almost always means a slash — silently topping
        //    up bleeds funds while hiding the underlying cause. Opt in with
        //    AUTO_RESTAKE=true for local dev / known-honest test runs.
        //
        //    Under-staked + opt-out: print a clear CLI setup instruction
        //    ONCE per process lifetime, then skip quietly on subsequent
        //    cycles so we don't flood logs every 30s.
        const currentStake = BigInt(await archive.stakes(w.address))
        if (currentStake < OPTIMISTIC_MIN_STAKE) {
          if (process.env.AUTO_RESTAKE !== 'true') {
            if (!underStakedWarned) {
              const archiveAddr = OPTIMISTIC_ARCHIVE_ADDRESS
              const amountEth = (Number(OPTIMISTIC_INITIAL_DEPOSIT) / 1e18).toFixed(2)
              const role = REPLICATOR_PRIVATE_KEY ? 'REPLICATOR' : 'VALIDATOR'
              console.warn(
                `\n` +
                `┌─ Replication paused: under-staked ─────────────────────┐\n` +
                `│ Your ${role} wallet (${w.address.slice(0,10)}…) has ${ethers_formatStake(currentStake)} ETH\n` +
                `│ staked on archive ${archiveAddr.slice(0,10)}…, but the\n` +
                `│ minimum is ${ethers_formatStake(OPTIMISTIC_MIN_STAKE)} ETH.\n` +
                `│\n` +
                `│ To replicate, deposit stake first:\n` +
                `│   cd client\n` +
                `│   npx tsx scripts/archive-deposit.ts ${role} ${amountEth}\n` +
                `│\n` +
                `│ (or set AUTO_RESTAKE=true to auto-top-up every cycle)\n` +
                `└────────────────────────────────────────────────────────┘`
              )
              underStakedWarned = true
            }
            return
          }
          console.log(`[OptimisticReplication] Stake ${currentStake} < MIN_STAKE ${OPTIMISTIC_MIN_STAKE}, depositing ${OPTIMISTIC_INITIAL_DEPOSIT}...`)
          const tx = await archiveW.deposit({ value: OPTIMISTIC_INITIAL_DEPOSIT })
          const receipt = await tx.wait()
          console.log(`[OptimisticReplication] Deposited ${OPTIMISTIC_INITIAL_DEPOSIT} wei as stake. tx: ${receipt?.hash}`)
        } else {
          // Reset so a future slash can re-trigger the prompt once.
          underStakedWarned = false
        }

        // Backpressure: don't submit more while we already have pending
        // submissions — if an earlier one turns out to be fraudulent, a slash
        // will cascade through ALL pending and cost the stake regardless of
        // how many we queued. For honest operation this bounds exposure
        // during LZ/monitor latency windows; for fraud-testing it prevents
        // the runaway "pre-slash spam" we kept observing.
        const maxPending = Number(process.env.MAX_PENDING_SUBMISSIONS || '1')
        const pending = Number(await archive.pendingCount(w.address))
        if (pending >= maxPending) {
          console.log(`[OptimisticReplication] pendingCount=${pending} >= MAX_PENDING_SUBMISSIONS=${maxPending} — waiting for existing submission(s) to finalize or slash before queueing more`)
          return
        }


        const httpProvider = replicationHttpProvider
        const cawActionsViewAbi = ['function clientActionCount(uint32) view returns (uint256)']
        const cawActionsView = new Contract(CAW_ACTIONS_ADDRESS, cawActionsViewAbi, httpProvider)

        for (const client of clients) {
          try {
            const actionCount = Number(await cawActionsView.clientActionCount(client.id))
            const totalCheckpoints = Math.floor(actionCount / OPTIMISTIC_CHECKPOINT_INTERVAL)
            if (totalCheckpoints === 0) continue

            // 3. Find unreplicated checkpoint range on L2b archive
            let startCheckpointId = 0
            for (let cp = 1; cp <= totalCheckpoints; cp++) {
              const claimed = Number(await archive.checkpointClaimed(client.id, cp))
              if (claimed === 0) {
                startCheckpointId = cp
                break
              }
            }

            if (startCheckpointId === 0) continue // Fully caught up

            // Find consecutive available checkpoints (max 256 per contract limit)
            let endCheckpointId = startCheckpointId
            const maxEnd = Math.min(totalCheckpoints, startCheckpointId + 255)
            for (let cp = startCheckpointId + 1; cp <= maxEnd; cp++) {
              const claimed = Number(await archive.checkpointClaimed(client.id, cp))
              if (claimed !== 0) break
              endCheckpointId = cp
            }

            // Verify range is still available (atomic check)
            const rangeAvailable = await archive.isRangeAvailable(client.id, startCheckpointId, endCheckpointId)
            if (!rangeAvailable) {
              console.log(`[OptimisticReplication] Client ${client.id}: range ${startCheckpointId}..${endCheckpointId} no longer available, skipping`)
              continue
            }

            let numCheckpoints = endCheckpointId - startCheckpointId + 1

            // Dynamic batch sizing. Budget applies to packedActions bytes only.
            // The actual submission tx carries packed + r[] + entryHash + ABI
            // overhead ≈ packed * 1.5. More importantly, `slashIncoherentRoot`
            // (the Mode A slash) ALSO echoes the same data back in its
            // calldata, so the slash tx is as big as the submission tx. RPC
            // providers (Infura, Arbitrum public) typically reject single-tx
            // bodies above ~50-60KB as "oversized"/"unparseable". Stay well
            // under so both submit AND slash txs fit.
            //   packed(30KB) * 1.5 ≈ 45KB tx → fits
            const L2B_CALLDATA_LIMIT = 30_000

            console.log(`[OptimisticReplication] Client ${client.id}: attempting checkpoints ${startCheckpointId}..${endCheckpointId} (${numCheckpoints})`)

            // 4. Reconstruct data from L2 events — try the full range first
            let data = await reconstructCheckpointData(client.id, startCheckpointId, endCheckpointId)
            if (!data) {
              console.error(`[OptimisticReplication] Failed to reconstruct data for client ${client.id} checkpoints ${startCheckpointId}..${endCheckpointId}`)
              continue
            }

            // Trim if payload is too large for L2b calldata
            while (data.packedBytes.length > L2B_CALLDATA_LIMIT && numCheckpoints > 1) {
              numCheckpoints = Math.max(1, Math.floor(numCheckpoints * 0.7)) // shrink by 30%
              endCheckpointId = startCheckpointId + numCheckpoints - 1
              console.log(`[OptimisticReplication] Trimming to ${numCheckpoints} checkpoints (${startCheckpointId}..${endCheckpointId}, payload was ${data.packedBytes.length} bytes)`)
              data = await reconstructCheckpointData(client.id, startCheckpointId, endCheckpointId)
              if (!data) break
            }

            if (!data) {
              console.error(`[OptimisticReplication] Failed to reconstruct data after trimming for client ${client.id}`)
              continue
            }

            const totalActions = numCheckpoints * OPTIMISTIC_CHECKPOINT_INTERVAL
            console.log(`[OptimisticReplication] Client ${client.id}: submitting checkpoints ${startCheckpointId}..${endCheckpointId} (${numCheckpoints} checkpoints, ${totalActions} actions, ${data.packedBytes.length} bytes)`)

            console.log(`[OptimisticReplication] Hash chain verified for client ${client.id} checkpoints ${startCheckpointId}..${endCheckpointId}`)

            // 5. Build merkle tree over checkpoint hashes
            const checkpointIds = Array.from(
              { length: numCheckpoints },
              (_, i) => startCheckpointId + i
            )
            let { root: merkleRoot } = buildCheckpointMerkleTree(checkpointIds, data.checkpointHashes)
            console.log(`[OptimisticReplication] Merkle root: ${merkleRoot}`)

            // TEST MODE: introduce a specific kind of fraud so the monitor
            // exercises the corresponding detection/slash path.
            if (CORRUPT_REPLICATION && CORRUPT_MODE === 'A') {
              // Mode A: swap the first checkpoint hash locally and rebuild
              // the tree, but leave packedActions + r as the honest
              // L2 values. The committed root no longer derives from the
              // emitted packedActions → slashIncoherentRoot will catch it.
              const badHashes = [...data.checkpointHashes]
              badHashes[0] = keccak256('0x434f525255505445445f5245504c49434154494f4e5f464f525f534c4153485f54455354') // "CORRUPTED_REPLICATION_FOR_SLASH_TEST"
              const corrupted = buildCheckpointMerkleTree(checkpointIds, badHashes)
              console.warn(`[OptimisticReplication] ⚠️  MODE A CORRUPTION: cp ${startCheckpointId} hash ${data.checkpointHashes[0]} → ${badHashes[0]}`)
              console.warn(`[OptimisticReplication] ⚠️  merkleRoot ${merkleRoot} → ${corrupted.root}`)
              data.checkpointHashes = badHashes
              merkleRoot = corrupted.root
            } else if (CORRUPT_REPLICATION && CORRUPT_MODE === 'B') {
              // Mode B: flip one byte inside packedActions, re-fold the hash
              // chain, build a root consistent with the corrupted data. The
              // root IS derivable from packedActions (slashIncoherentRoot
              // would NOT fire), but individual checkpoint hashes now
              // diverge from L2's canonical ones → resolveChallenge fires.
              const badPacked = new Uint8Array(data.packedBytes)
              // Flip byte at action index 0, offset 1 (senderId's high byte)
              // within the 25-byte action layout: [type(1)][senderId(4)]...
              // That change propagates through actionHash → every checkpoint
              // hash from this point forward differs from L2.
              const flipOffset = 2 + 1
              badPacked[flipOffset] = badPacked[flipOffset] ^ 0xff
              const badActionSlices = getPackedActionSlices(badPacked)

              // Refold to get the corrupt-but-consistent checkpoint hashes.
              const prevHash = data.entryHash
              const badCheckpointHashes: string[] = []
              let h = prevHash
              for (let i = 0; i < badActionSlices.length; i++) {
                const actionHash = keccak256(bytesToHex(badActionSlices[i]))
                h = keccak256(solidityPacked(['bytes32', 'bytes32', 'bytes32'], [h, data.allR[i], actionHash]))
                if ((i + 1) % OPTIMISTIC_CHECKPOINT_INTERVAL === 0) badCheckpointHashes.push(h)
              }
              const corrupted = buildCheckpointMerkleTree(checkpointIds, badCheckpointHashes)
              console.warn(`[OptimisticReplication] ⚠️  MODE B CORRUPTION: flipped packedBytes[${flipOffset}]`)
              console.warn(`[OptimisticReplication] ⚠️  merkleRoot ${merkleRoot} → ${corrupted.root}`)
              data.packedBytes = badPacked
              data.checkpointHashes = badCheckpointHashes
              merkleRoot = corrupted.root
            }

            // 6. Submit to L2b archive
            const packedHex = bytesToHex(data.packedBytes)

            // Pre-flight simulation
            try {
              await archiveW.submitReplication.staticCall(
                client.id, startCheckpointId, endCheckpointId,
                packedHex, data.allR, merkleRoot, data.entryHash
              )
            } catch (simErr: any) {
              const reason = simErr?.revert?.args?.[0] || simErr?.reason || simErr?.shortMessage || simErr?.message || 'unknown'
              console.error(`[OptimisticReplication] Pre-flight failed for client ${client.id}: ${reason}`)
              continue
            }

            // Estimate gas and submit
            let gasLimit: bigint
            try {
              const estimated = await archiveW.submitReplication.estimateGas(
                client.id, startCheckpointId, endCheckpointId,
                packedHex, data.allR, merkleRoot, data.entryHash
              )
              gasLimit = (estimated * 120n) / 100n // 20% buffer for L2b
              if (gasLimit > 30_000_000n) gasLimit = 30_000_000n
            } catch (gasErr: any) {
              console.warn(`[OptimisticReplication] estimateGas failed (${gasErr?.shortMessage || gasErr?.message}), using 15M fallback`)
              gasLimit = 15_000_000n
            }

            const tx = await archiveW.submitReplication(
              client.id, startCheckpointId, endCheckpointId,
              packedHex, data.allR, merkleRoot, data.entryHash,
              { gasLimit }
            )
            const receipt = await tx.wait()
            console.log(`[OptimisticReplication] Submitted! tx: ${receipt?.hash} (gas: ${receipt?.gasUsed}/${gasLimit})`)

            // Record analytics
            if (receipt) {
              try {
                await prisma.replicationTx.create({ data: {
                  txHash: receipt.hash,
                  blockNumber: BigInt(receipt.blockNumber),
                  clientId: client.id,
                  checkpointId: startCheckpointId,
                  endCheckpointId,
                  actionCount: numCheckpoints * OPTIMISTIC_CHECKPOINT_INTERVAL,
                  gasUsed: receipt.gasUsed.toString(),
                  gasPrice: receipt.fee ? (receipt.fee / receipt.gasUsed).toString() : '0',
                  ethCost: receipt.fee?.toString() || '0',
                  totalCost: receipt.fee?.toString() || '0',
                  submitter: w.address.toLowerCase(),
                }})
              } catch (e: any) { console.error('[Analytics] Failed to record optimistic replication:', e.message) }
            }
          } catch (err: any) {
            console.error(`[OptimisticReplication] Failed for client ${client.id}: ${formatRpcError(err)}`)
          }
        }

        // 7. Auto-finalize past submissions
        await autoFinalizeSubmissions()

        // 8. Auto-withdraw excess stake
        await autoWithdrawExcessStake()

      } catch (err: any) {
        console.error(`[OptimisticReplication] Loop error: ${formatRpcError(err)}`)
      }
    }

    /**
     * Finalize submissions whose challenge period has expired.
     */
    async function autoFinalizeSubmissions() {
      try {
        const { archiveRead: archive, archiveWrite: archiveW, l2bProvider: provider, l2bWallet: w } = getL2bContracts()

        // Query SubmissionCreated events from our address
        const latestBlock = await provider!.getBlockNumber()
        // Look back ~4 days of blocks (~12s/block on Arbitrum = ~28800 blocks/day)
        const fromBlock = Math.max(0, latestBlock - 28800 * 4)

        const events = await archive.queryFilter(
          archive.filters.SubmissionCreated(null, w.address),
          fromBlock,
          latestBlock
        )

        for (const ev of events) {
          const args: any = (ev as any).args
          if (!args) continue
          const submissionId = Number(args[0] || args.submissionId)

          try {
            const sub = await archive.getSubmission(submissionId)
            const status = Number(sub[6]) // status enum: 0=PENDING, 1=FINALIZED, 2=SLASHED
            if (status !== 0) continue // Not pending

            const finalizedAt = Number(sub[5])
            const now = Math.floor(Date.now() / 1000)
            if (now < finalizedAt) continue // Challenge period still active

            console.log(`[OptimisticReplication] Finalizing submission ${submissionId}...`)
            const tx = await archiveW.finalizeSubmission(submissionId)
            const receipt = await tx.wait()
            console.log(`[OptimisticReplication] Finalized submission ${submissionId}. tx: ${receipt?.hash}`)
          } catch (err: any) {
            // Already finalized or slashed — not an error
            if (err?.reason?.includes('Not pending')) continue
            console.error(`[OptimisticReplication] Failed to finalize submission ${submissionId}: ${err?.shortMessage || err?.message}`)
          }
        }
      } catch (err: any) {
        console.error(`[OptimisticReplication] Auto-finalize error: ${err?.shortMessage || err?.message}`)
      }
    }

    /**
     * Withdraw excess stake when no pending submissions remain and stake > 3x minimum.
     */
    async function autoWithdrawExcessStake() {
      try {
        const { archiveRead: archive, archiveWrite: archiveW, l2bWallet: w } = getL2bContracts()

        const pending = Number(await archive.pendingCount(w.address))
        if (pending > 0) return // Can't withdraw with pending submissions

        const currentStake = BigInt(await archive.stakes(w.address))
        const threshold = OPTIMISTIC_MIN_STAKE * 3n

        if (currentStake <= threshold) return

        const withdrawAmount = currentStake - OPTIMISTIC_MIN_STAKE * 2n // Keep 2x MIN_STAKE as buffer
        if (withdrawAmount <= 0n) return

        console.log(`[OptimisticReplication] Withdrawing excess stake: ${withdrawAmount} wei (keeping ${currentStake - withdrawAmount} wei)`)
        const tx = await archiveW.withdraw(withdrawAmount)
        const receipt = await tx.wait()
        console.log(`[OptimisticReplication] Withdrew ${withdrawAmount} wei. tx: ${receipt?.hash}`)
      } catch (err: any) {
        console.error(`[OptimisticReplication] Auto-withdraw error: ${err?.shortMessage || err?.message}`)
      }
    }

    /**
     * Monitor other validators' optimistic submissions for fraud.
     * Checks that submitted checkpoint hashes match L2's on-chain hashes.
     * Logs warnings on mismatch (actual challenge submission is a follow-up).
     */
    async function monitorOptimisticSubmissions() {
      try {
        // Use the MONITOR wallet here so that a separate REPLICATOR_PRIVATE_KEY
        // submitter's submissions are not skipped as "our own" — the monitor
        // wants to challenge them during the slash test.
        const { archiveRead: archive, l2bProvider: provider, l2bMonitorWallet: w } = getL2bContracts()

        const latestBlock = await provider!.getBlockNumber()
        // Look back ~3 days of blocks
        const fromBlock = Math.max(0, latestBlock - 28800 * 3)

        // Query ALL SubmissionCreated events (not just ours)
        const events = await archive.queryFilter(
          archive.filters.SubmissionCreated(),
          fromBlock,
          latestBlock
        )

        const httpProvider = replicationHttpProvider
        const hashCheckAbi = ['function clientHashAtCheckpoint(uint32,uint256) view returns (bytes32)']
        const actionsView = new Contract(CAW_ACTIONS_ADDRESS, hashCheckAbi, httpProvider)

        for (const ev of events) {
          const args: any = (ev as any).args
          if (!args) continue

          const submissionId = Number(args[0] || args.submissionId)
          const submitter = args[1] || args.submitter
          const clientId = Number(args[2] || args.clientId)
          const startCp = Number(args[3] || args.startCheckpointId)
          const endCp = Number(args[4] || args.endCheckpointId)

          // Skip our own submissions
          if (submitter.toLowerCase() === w.address.toLowerCase()) continue

          // Check if still pending
          let merkleRoot: string
          try {
            const sub = await archive.getSubmission(submissionId)
            const status = Number(sub[6])
            if (status !== 0) continue // Already finalized or slashed
            merkleRoot = sub[1] // bytes32 merkleRoot
          } catch { continue }

          // Set up contract handles once per submission.
          const resolveAbi = [
            'function challengeDelivered(uint256, uint256) view returns (bool)',
            'function challengeHash(uint256, uint256) view returns (bytes32)',
            'function resolveChallenge(uint256 submissionId, uint256 checkpointId, bytes32 claimedHash, bytes32[] merkleProof)',
            'function slashIncoherentRoot(uint256 submissionId, bytes packedActions, bytes32[] r, bytes32 entryHash)',
          ]
          const archiveW = new Contract(OPTIMISTIC_ARCHIVE_ADDRESS, resolveAbi, new Wallet(privateKey!, l2bProvider))
          const archiveResolveRead = new Contract(OPTIMISTIC_ARCHIVE_ADDRESS, resolveAbi, l2bProvider)

          // --- Build the SUBMITTER'S OWN claimed view of this range ------
          //
          // For Mode B detection: an honest-looking submission's packedActions
          // hash up to its committed merkle root. If those hashes don't match
          // L2's canonical clientHashAtCheckpoint, the submitter committed to
          // invented actions — which we can prove by supplying their own
          // claimedHash + a valid proof in their own tree.
          //
          // If rebuilding from ActionsArchived produces a root that DOESN'T
          // match sub.merkleRoot, this is Mode A (incoherent root). Current
          // resolveChallenge cannot slash it; flagged for the dedicated
          // slashIncoherentRoot path.
          let submitterHashes: string[] | null = null
          let submitterTree: ReturnType<typeof buildCheckpointMerkleTree> | null = null
          let modeA = false
          try {
            const numCp = endCp - startCp + 1
            const archivedEvents = await archive.queryFilter(
              archive.filters.ActionsArchived(submissionId),
              fromBlock, latestBlock,
            )
            const archivedArgs: any = (archivedEvents[0] as any)?.args
            if (!archivedArgs) throw new Error('ActionsArchived event missing')
            const submitterPackedHex = archivedArgs[2] as string
            const submitterR = (archivedArgs[3] as string[]).map(x => String(x))

            const entryHash = startCp === 1
              ? '0x' + '00'.repeat(32)
              : await actionsView.clientHashAtCheckpoint(clientId, startCp - 1)

            const packedBytes = Buffer.from(submitterPackedHex.slice(2), 'hex')
            submitterHashes = foldCheckpointHashes(
              new Uint8Array(packedBytes), submitterR, entryHash, startCp, endCp, OPTIMISTIC_CHECKPOINT_INTERVAL,
            )
            if (!submitterHashes) throw new Error('submitter action count mismatch')

            const checkpointIds = Array.from({ length: numCp }, (_, i) => startCp + i)
            submitterTree = buildCheckpointMerkleTree(checkpointIds, submitterHashes)
            if (submitterTree.root.toLowerCase() !== merkleRoot.toLowerCase()) {
              modeA = true
            }
          } catch (e: any) {
            console.warn(`[Monitor] Could not rebuild submitter tree for submission ${submissionId}: ${e?.message}`)
          }

          // --- Resolve previously-relayed challenges -------------------
          // LZ has delivered correctHash into the archive; we now need to
          // provide the submitter's claimedHash + a merkle proof in their
          // tree. If submitterTree is null (couldn't rebuild) we can't
          // proceed — this cycle will retry next round.
          //
          // Run per-cp resolve in parallel. Once any resolveChallenge
          // lands, the archive flips the submission to SLASHED and all
          // later resolves in this batch revert with "Not pending" —
          // harmless, just caught and logged. This is still vastly
          // better than serial: one honest monitor race can win in
          // ~1 block instead of waiting through a serial queue.
          const resolveOne = async (cpId: number) => {
            try {
              const delivered = await archiveResolveRead.challengeDelivered(submissionId, cpId)
              if (!delivered) return
              if (!submitterHashes || !submitterTree) return

              const correctHash = await archiveResolveRead.challengeHash(submissionId, cpId)
              const cpIndex = cpId - startCp
              const claimedHash = submitterHashes[cpIndex]
              const proof = submitterTree.getProof(cpIndex)

              if (correctHash.toLowerCase() === claimedHash.toLowerCase()) {
                console.log(`[Monitor] Challenge for submission ${submissionId} cp ${cpId}: submitter's hash matches L2 (no fraud on this cp)`)
                return
              }

              const claimedLock = await tryClaimChallengeLock('resolve', submissionId, cpId, w.address.toLowerCase(), 10 * 60 * 1000)
              if (!claimedLock) return

              console.log(`[Monitor] Resolving challenge for submission ${submissionId} checkpoint ${cpId}...`)
              try {
                const resolveTx = await archiveW.resolveChallenge(submissionId, cpId, claimedHash, proof, { gasLimit: 500_000 })
                const resolveReceipt = await resolveTx.wait()
                console.log(`[Monitor] SLASHED submission ${submissionId}! tx: ${resolveReceipt?.hash}`)
                await releaseChallengeLock('resolve', submissionId, cpId, 'success', resolveReceipt?.hash)
              } catch (e) {
                await releaseChallengeLock('resolve', submissionId, cpId, 'error')
                throw e
              }
            } catch (resolveErr: any) {
              console.warn(`[Monitor] Error resolving challenge for submission ${submissionId} cp ${cpId}: ${resolveErr?.shortMessage || resolveErr?.message}`)
            }
          }
          // Resolve sequentially. Parallel sends collided on nonces (ethers's
          // provider caches the nonce, so Promise.all-fired txs all grabbed
          // the same one), and anyway the FIRST successful resolve flips the
          // submission to SLASHED and invalidates all of this validator's
          // pending submissions — the remaining cps would revert with
          // "Not pending" regardless. Serial + early exit on slash is both
          // correct and cheaper.
          for (let cpId = startCp; cpId <= endCp; cpId++) {
            await resolveOne(cpId)
            // Re-check status: if the submission flipped to SLASHED, the
            // remaining cps are no-ops. Save the RPC round-trip.
            try {
              const sub2 = await archive.getSubmission(submissionId)
              if (Number(sub2[6]) !== 0) break
            } catch { /* ignore, continue loop */ }
          }

          // --- Detect & relay new fraud challenges ---------------------
          // Collect all fraudulent cps then relay them in one batch LZ
          // message via relayChallengeBatch. The submission-scoped lock
          // ('relayBatch') prevents multiple monitor nodes from each
          // sending their own batch for the same submission.
          const relayBatch = async (cps: number[], reason: string) => {
            if (cps.length === 0) return

            // Filter out cps that already have a challenge delivered.
            const notYetDelivered: number[] = []
            for (const cp of cps) {
              try {
                const delivered = await archiveResolveRead.challengeDelivered(submissionId, cp)
                if (!delivered) notYetDelivered.push(cp)
              } catch { notYetDelivered.push(cp) /* if view fails, try */ }
            }
            if (notYetDelivered.length === 0) return

            const holder = w.address.toLowerCase()
            const lockClaimed = await tryClaimChallengeLock('relayBatch', submissionId, 0, holder, 10 * 60 * 1000)
            if (!lockClaimed) return

            const L2B_EID = 40231
            const relayAbi = [
              'function relayChallengeBatch(uint32 destEid, uint256 submissionId, uint32 clientId, uint256[] checkpointIds) payable',
              'function quoteChallengeBatch(uint32 destEid, uint256 submissionId, uint32 clientId, uint256[] checkpointIds, bool payInLzToken) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))',
            ]
            const relayContract = new Contract(CHALLENGE_RELAY_ADDRESS, relayAbi, new Wallet(privateKey!, replicationHttpProvider))

            try {
              const quote = await relayContract.quoteChallengeBatch(L2B_EID, submissionId, clientId, notYetDelivered, false)
              // Gas scales with cp count: ~100k base + ~40k per cp on the
              // source chain (endpoint + payload encoding). 200k + 60k/cp
              // with a buffer.
              const gasLimit = 200_000n + 60_000n * BigInt(notYetDelivered.length)
              const relayTx = await relayContract.relayChallengeBatch(
                L2B_EID, submissionId, clientId, notYetDelivered,
                { value: quote.nativeFee * 120n / 100n, gasLimit },
              )
              const relayReceipt = await relayTx.wait()
              console.log(`[Monitor] Challenge batch relayed (${reason}) for submission ${submissionId} cps=[${notYetDelivered.join(',')}]. tx: ${relayReceipt?.hash}`)
              await releaseChallengeLock('relayBatch', submissionId, 0, 'success', relayReceipt?.hash)
            } catch (e) {
              await releaseChallengeLock('relayBatch', submissionId, 0, 'error')
              throw e
            }
          }

          try {
            if (modeA) {
              // Mode A: committed root doesn't even commit to the submitter's
              // own packedActions. Call slashIncoherentRoot which re-hashes
              // the data on-chain and slashes if the rebuilt root differs.
              console.error(
                `[Monitor] MODE A FRAUD (incoherent root) in submission ${submissionId}: ` +
                `committedRoot=${merkleRoot} does not match root built from submitter's own packedActions.`
              )

              const lockHolder = w.address.toLowerCase()
              const claimed = await tryClaimChallengeLock('slashIncoherent', submissionId, 0, lockHolder, 10 * 60 * 1000)
              if (!claimed) continue

              try {
                // Fetch submitter's packedActions + r from ActionsArchived
                // (we already did this above; re-use the captured values).
                const archivedEvents = await archive.queryFilter(
                  archive.filters.ActionsArchived(submissionId),
                  fromBlock, latestBlock,
                )
                const archivedArgs: any = (archivedEvents[0] as any)?.args
                const submitterPackedHex = archivedArgs[2] as string
                const submitterR = (archivedArgs[3] as string[]).map((x: string) => String(x))

                // entryHash: honest L2's clientHashAtCheckpoint at startCp-1.
                // If submitter lied about entryHash, the contract's
                // dataCommitment check will fail — but that's Mode B which
                // was caught above, so reaching here means entryHash matched.
                const entryHash = startCp === 1
                  ? '0x' + '00'.repeat(32)
                  : await actionsView.clientHashAtCheckpoint(clientId, startCp - 1)

                console.log(`[Monitor] Calling slashIncoherentRoot(${submissionId})...`)
                // slashIncoherentRoot does: keccak check, full hash-chain
                // fold (per-action), build merkle root. 256 actions → ~5M gas
                // observed; 10M leaves margin for larger batches.
                const slashTx = await archiveW.slashIncoherentRoot(
                  submissionId, submitterPackedHex, submitterR, entryHash,
                  { gasLimit: 10_000_000 },
                )
                const slashReceipt = await slashTx.wait()
                console.log(`[Monitor] Mode A SLASHED submission ${submissionId}! tx: ${slashReceipt?.hash}`)
                await releaseChallengeLock('slashIncoherent', submissionId, 0, 'success', slashReceipt?.hash)
              } catch (e: any) {
                console.error(`[Monitor] slashIncoherentRoot failed for ${submissionId}: ${e?.shortMessage || e?.message}`)
                await releaseChallengeLock('slashIncoherent', submissionId, 0, 'error')
              }
              continue
            }

            if (!submitterHashes) {
              console.warn(`[Monitor] Submission ${submissionId}: no submitter view available — skipping`)
              continue
            }

            // Mode B detection: compare each submitter-claimed checkpoint
            // hash to the canonical L2 value. Collect all mismatches then
            // challenge them in one batch LZ message.
            const fraudulentCps: number[] = []
            for (let i = 0; i < submitterHashes.length; i++) {
              const cpId = startCp + i
              const claimedHash = submitterHashes[i]
              let l2Hash: string
              try {
                l2Hash = await actionsView.clientHashAtCheckpoint(clientId, cpId)
              } catch {
                console.warn(`[Monitor] Could not read L2 hash for checkpoint ${cpId}, skipping`)
                continue
              }
              if (claimedHash.toLowerCase() !== l2Hash.toLowerCase()) {
                console.error(
                  `[Monitor] MODE B FRAUD in submission ${submissionId} cp ${cpId}: ` +
                  `submitterClaimed=${claimedHash} L2=${l2Hash} submitter=${submitter}`
                )
                fraudulentCps.push(cpId)
              }
            }

            if (fraudulentCps.length > 0) {
              try { await relayBatch(fraudulentCps, 'mode B') }
              catch (e: any) { console.error(`[Monitor] Failed to relay batch for submission ${submissionId}: ${e?.shortMessage || e?.message}`) }
            } else {
              console.log(`[Monitor] Submission ${submissionId} verified OK (client ${clientId}, ${startCp}..${endCp}, submitter ${submitter.slice(0, 10)}...)`)
            }
          } catch (err: any) {
            console.warn(`[Monitor] Error verifying submission ${submissionId}: ${err?.shortMessage || err?.message}`)
          }
        }
      } catch (err: any) {
        console.error(`[Monitor] Loop error: ${err?.shortMessage || err?.message}`)
      }
    }

    // ================================================================
    // Loop lifecycle and scheduling
    // ================================================================

    // Declare all loops with the watchdog. Timeouts are generous — 3x the
    // typical interval — so transient slowness doesn't trigger a restart,
    // but a truly hung loop will be caught within a few minutes.
    ctx.declareLoop('poll', Math.max(checkInterval * 3, 60_000))
    ctx.declareLoop('optimisticReplication', Math.max(60_000 * 3, 180_000))
    // Monitor can do a lot of work in one cycle: fetch events, rebuild
    // submitter trees, batch-relay challenges, call resolveChallenge, or
    // slashIncoherentRoot. Batch relay is one tx but resolveChallenge
    // still runs per-cp (in parallel). 15-minute timeout covers a burst
    // of several submissions during a live fraud storm without false-
    // positive restarts.
    ctx.declareLoop('monitor', 15 * 60_000)

    // start polling with overlap protection
    let isPolling = false
    const safePollLoop = async () => {
      if (isPolling) {
        console.log('[Validator] Poll cycle still in progress, skipping this interval')
        return
      }
      isPolling = true
      try {
        await pollLoop()
        ctx.heartbeat('poll')
      } catch (err) {
        console.error(err)
      } finally {
        isPolling = false
      }
    }

    // Optimistic replication loop (stake-based, direct L2b)
    let isOptimisticReplicating = false
    let optimisticReplicationTimer: ReturnType<typeof setTimeout>
    const safeOptimisticReplicationLoop = async () => {
      if (isOptimisticReplicating) return
      isOptimisticReplicating = true
      try {
        await optimisticReplicationLoop()
        ctx.heartbeat('optimisticReplication')
      } catch (err) {
        console.error('[OptimisticReplication] Unhandled error:', err)
      } finally {
        isOptimisticReplicating = false
      }
    }

    // Monitor loop (checks other validators' submissions for fraud)
    let isMonitoring = false
    let monitorTimer: ReturnType<typeof setTimeout>
    const safeMonitorLoop = async () => {
      if (isMonitoring) return
      isMonitoring = true
      try {
        await monitorOptimisticSubmissions()
        ctx.heartbeat('monitor')
      } catch (err) {
        console.error('[Monitor] Unhandled error:', err)
      } finally {
        isMonitoring = false
      }
    }

    // Load DB settings before first poll (env/config values serve as defaults).
    // Settings are also refreshed at the start of every poll cycle.
    refreshSettings(checkInterval).catch(err => {
      console.error('[Validator] refreshSettings failed, continuing with defaults:', err.message)
    }).then(() => {
      const httpRpcUrlForLog = getL2HttpRpcUrl(l2RpcUrl)
      console.log(`[Validator] Starting validator service with:`);
      console.log(`  - L2 WS RPC: ${l2RpcUrl.slice(0, 50)}...`);
      console.log(`  - L2 HTTP RPC: ${httpRpcUrlForLog.slice(0, 50)}...`);
      console.log(`  - L1 RPC (mainnet): ${ethMainnetRpcUrl?.slice(0, 50) || 'NOT SET'}...`);
      console.log(`  - Validator ID: ${validatorId}`);
      console.log(`  - Check Interval: ${liveSettings.checkInterval}ms`);
      console.log(`  - Base Tip: ${liveSettings.validatorBaseTip} CAW`);
      console.log(`  - Replication Interval: ${liveSettings.replicationInterval}ms`);
      console.log(`  - Wallet Address: ${wallet.address}`);

      // Use setTimeout chains instead of setInterval so updated settings take effect immediately
      function schedulePoll() {
        timer = setTimeout(async () => {
          await safePollLoop()
          schedulePoll()
        }, liveSettings.checkInterval)
      }
      function scheduleOptimisticReplication() {
        optimisticReplicationTimer = setTimeout(async () => {
          await safeOptimisticReplicationLoop()
          scheduleOptimisticReplication()
        }, liveSettings.replicationInterval)
      }
      function scheduleMonitor() {
        // Monitor runs less frequently — 5x the replication interval
        monitorTimer = setTimeout(async () => {
          await safeMonitorLoop()
          scheduleMonitor()
        }, liveSettings.replicationInterval * 5)
      }

      safePollLoop()
      schedulePoll()

      console.log('[OptimisticReplication] Starting optimistic replication and monitor loops')
      safeOptimisticReplicationLoop()
      scheduleOptimisticReplication()
      safeMonitorLoop()
      scheduleMonitor()
    })

    return {
      started: Promise.resolve(),
      async stop() {
        clearTimeout(timer)
        clearTimeout(optimisticReplicationTimer)
        clearTimeout(monitorTimer)
        // No need to remove handler since it's managed globally
        if (provider) {
          try {
            provider.destroy()
          } catch (e) {
            // Ignore cleanup errors
          }
        }
      },
      stats: async () => {
        const count = await prisma.txQueue.count({ where: { status: 'pending' } })
        return `pending=${count}`
      }
    }
  }
}


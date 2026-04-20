// src/services/ValidatorService/index.ts

import { z } from 'zod'
import 'dotenv/config'
import { Service } from '../../Service'
import { prisma }  from '../../prismaClient'
import getActionType from '../../abi/getActionType'
import { cawActionsAbi } from '../../abi/generated'
import { CAW_ACTIONS_ADDRESS, CAW_ACTIONS_REPLICATOR_L2_ADDRESS, CAW_ADDRESS, WETH_ADDRESS } from '../../abi/addresses'
import { WebSocketProvider, JsonRpcProvider, Contract, Wallet, Interface, keccak256, solidityPacked, AbiCoder } from 'ethers'
import { packActions, packSignatures, bytesToHex, getPackedActionSlices, unpackActions } from '../../utils/packActions'
import { buildCheckpointMerkleTree } from '../../utils/checkpointMerkle'
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
    cachedMainnetProvider = makeJsonRpcProvider(mainnetRpcUrl)
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
    const httpProvider = makeJsonRpcProvider(l2HttpRpcUrl)
    console.log(`[Validator] HTTP RPC (for eth_call / gas): ${l2HttpRpcUrl.slice(0, 50)}...`)

    // Note: Uncaught exception handling is done at the process level in programs/start.ts
    // No need for service-specific handlers

    // Function to initialize/reinitialize the WebSocket connection
    async function initializeConnection() {
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
        provider = makeWebSocketProvider(l2RpcUrl)

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
        const textLen = typeof data?.text === 'string' ? data.text.length : 0
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
      const calldata = packedIface.encodeFunctionData('processActions', [
        validatorId,
        multiData.packedActions,
        multiData.packedSigs,
        quote.withdrawFee,
        quote.withdrawLzTokenAmount,
      ])

      const gasLimitRaw = await httpProvider.estimateGas({
        to:    CAW_ACTIONS_ADDRESS,
        data:  calldata,
        value: quote.nativeFee
      })

      const feeData = await httpProvider.getFeeData()
      const gasPrice = feeData.gasPrice ?? BigInt(0)

      return gasLimitRaw * gasPrice;
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

      // 2) Ask the provider directly for the gas estimate (via HTTP — WSS
      //    estimateGas with large calldata is where we were seeing hangs too).
      const estimate = await httpProvider.estimateGas({
        to:             CAW_ACTIONS_ADDRESS,
        data:           calldata,
        value:          quote.nativeFee,
      });

      return estimate;
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

      console.log("will submit ", multiData.actions.length, multiData)
      console.log("[submitProcessActions] Getting fee data..." + (retryCount > 0 ? ` (retry ${retryCount}/${maxRetries})` : ''))
      const feeData = await httpProvider.getFeeData();

      // Bump gas fees on retry to handle REPLACEMENT_UNDERPRICED errors
      let maxFeePerGas = feeData.maxFeePerGas ?? BigInt(0)
      let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? BigInt(0)

      if (retryCount > 0) {
        const multiplier = BigInt(100 + (gasBumpPercent * retryCount))
        maxFeePerGas = (maxFeePerGas * multiplier) / BigInt(100)
        maxPriorityFeePerGas = (maxPriorityFeePerGas * multiplier) / BigInt(100)
        console.log(`[submitProcessActions] Bumped gas fees by ${gasBumpPercent * retryCount}% for retry`)
      }

      console.log("[submitProcessActions] Fee data:", {
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
        retryCount
      })

      console.log("[submitProcessActions] Sending transaction with params:", {
        to: CAW_ACTIONS_ADDRESS,
        validatorId,
        actionsCount: multiData.actions.length,
        totalNativeFee: quote.nativeFee.toString(),
        withdrawFee: quote.withdrawFee.toString(),
        gasLimit: rawGasLimit.toString()
      })

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

        console.log(`[submitProcessActions] Calldata encoded (${txData.length} chars), sending transaction...`)

        // sendTransaction with full 5-argument signature
        const tx = await wallet.sendTransaction({
          to:    CAW_ACTIONS_ADDRESS,
          data:  txData,
          value: quote.nativeFee,
          gasLimit: rawGasLimit,
          maxFeePerGas,
          maxPriorityFeePerGas,
        })
        console.log("[submitProcessActions] Transaction sent! Hash:", tx.hash)
        console.log("[submitProcessActions] Waiting for confirmation...")

        const receipt = await tx.wait()
        console.log("[submitProcessActions] Transaction confirmed! Block:", receipt?.blockNumber, "Status:", receipt?.status)

        const evt = receipt?.logs
          ?.map(log => { try { return iface.parseLog(log) } catch { return null } })
          ?.find(x => x?.name === 'ActionsProcessed')

        if (!evt) {
          console.error("[submitProcessActions] ActionsProcessed event missing from receipt!")
          console.error("[submitProcessActions] Receipt logs:", receipt?.logs)
          throw new Error('ActionsProcessed event missing')
        }

        console.log("[submitProcessActions] ActionsProcessed event found")
        // Decode packed bytes from ActionsProcessed(bytes packedActions) event
        const packedHex = evt.args.packedActions as string
        const packedBuf = new Uint8Array((packedHex.startsWith('0x') ? packedHex.slice(2) : packedHex).match(/.{2}/g)!.map(b => parseInt(b, 16)))
        const decoded = unpackActions(packedBuf)
        const processed = decoded.map(a => ({
          senderId:     Number(a.senderId),
          cawonce:      Number(a.cawonce)
        }))
        console.log("[submitProcessActions] Processed actions:", processed)
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

      await Promise.all(queueEntries.map(async (entry, index) => {
        const data = (entry.payload as any).data
        const key  = `${data.senderId}-${data.cawonce}`

        // Check "Cawonce already used" — verify in Action table before marking done
        const rejection = simulationRejections[index] || ''
        const cawonceUsed = rejection.includes('Cawonce already used')
        let processedByOther = false
        if (cawonceUsed) {
          const existingAction = await prisma.action.findFirst({
            where: { senderId: data.senderId, cawonce: data.cawonce }
          })
          if (existingAction) {
            // Verify this is actually the same action, not a different one reusing the cawonce.
            // Compare actionType, receiverId, receiverCawonce, and text.
            const ex = existingAction.data as any
            const sameAction =
              Number(ex?.actionType ?? -1) === Number(data.actionType) &&
              Number(ex?.receiverId ?? -1) === Number(data.receiverId ?? 0) &&
              Number(ex?.receiverCawonce ?? -1) === Number(data.receiverCawonce ?? 0) &&
              (ex?.text ?? '') === (data.text ?? '')
            processedByOther = sameAction
            if (!sameAction) {
              console.log(`[Validator] TxQueue ${entry.id}: Cawonce ${data.cawonce} used by DIFFERENT action — marking failed`)
              console.log(`  existing: type=${ex?.actionType} receiver=${ex?.receiverId} text="${(ex?.text ?? '').slice(0, 40)}"`)
              console.log(`  new:      type=${data.actionType} receiver=${data.receiverId} text="${(data.text ?? '').slice(0, 40)}"`)
            }
          }
        }

        let newStatus = succeededKeys.has(key) || processedByOther
          ? 'done'
          : 'failed'

        // Get the rejection reason for this specific entry
        let reason = newStatus === 'failed' && simulationRejections[index]
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
                await Promise.all(subBatchEntries.map(async (entry, idx) => {
                  const data = (entry.payload as any).data
                  const rejection = simResult?.rejectionMessages?.[idx] || ''
                  const cawonceUsed = rejection.includes('Cawonce already used')
                  let processedByOther = false
                  if (cawonceUsed) {
                    const existingAction = await prisma.action.findFirst({
                      where: { senderId: data.senderId, cawonce: data.cawonce }
                    })
                    if (existingAction) {
                      const ex = existingAction.data as any
                      processedByOther =
                        Number(ex?.actionType ?? -1) === Number(data.actionType) &&
                        Number(ex?.receiverId ?? -1) === Number(data.receiverId ?? 0) &&
                        Number(ex?.receiverCawonce ?? -1) === Number(data.receiverCawonce ?? 0) &&
                        (ex?.text ?? '') === (data.text ?? '')
                    }
                  }
                  let failStatus = 'failed'
                  let failReason: string | null = processedByOther ? null : (cawonceUsed && !processedByOther ? 'Cawonce already used' : (rejection || 'Simulation failed'))
                  if (!processedByOther && failReason) {
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
                    // waiting_for_deposit path
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
          await Promise.all(validatedEntries.map(async (entry) => {
            const data = (entry.payload as any).data
            // Check if an Action record exists for this exact senderId + cawonce
            const existingAction = await prisma.action.findFirst({
              where: { senderId: data.senderId, cawonce: data.cawonce }
            })
            if (existingAction) {
              // Verify this is the same action, not a different one reusing the cawonce
              const ex = existingAction.data as any
              const sameAction =
                Number(ex?.actionType ?? -1) === Number(data.actionType) &&
                Number(ex?.receiverId ?? -1) === Number(data.receiverId ?? 0) &&
                Number(ex?.receiverCawonce ?? -1) === Number(data.receiverCawonce ?? 0) &&
                (ex?.text ?? '') === (data.text ?? '')
              if (sameAction) {
                console.log(`[Validator] TxQueue ${entry.id}: Same action exists for senderId=${data.senderId} cawonce=${data.cawonce} — marking done`)
                await prisma.txQueue.update({ where: { id: entry.id }, data: { status: 'done' } })
              } else {
                console.log(`[Validator] TxQueue ${entry.id}: Cawonce ${data.cawonce} used by DIFFERENT action — marking failed`)
                console.log(`  existing: type=${ex?.actionType} receiver=${ex?.receiverId} text="${(ex?.text ?? '').slice(0, 40)}"`)
                console.log(`  new:      type=${data.actionType} receiver=${data.receiverId} text="${(data.text ?? '').slice(0, 40)}"`)
                await markTxQueueFailed(
                  entry.id,
                  'Cawonce already used',
                  data.senderId,
                  data
                )
              }
            } else {
              console.log(`[Validator] TxQueue ${entry.id}: No Action found for senderId=${data.senderId} cawonce=${data.cawonce} — cawonce conflict, marking failed`)
              await markTxQueueFailed(
                entry.id,
                'Cawonce already used',
                data.senderId,
                data
              )
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
                 lowerMsg.includes('will retry')
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
        console.log("[Validator] ========== TRANSACTION SUBMISSION SUCCESSFUL ==========")
        console.log(`[Validator] ${finalized.length} actions finalized on chain`)
        finalized.forEach((f: any) => {
          console.log(`  - Sender ${f.senderId} cawonce ${f.cawonce}: ${getActionType(f.actionType)}`)
        })

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

        // Check if this is a provider/network error that should be retried
        if (submitErr.message?.includes('provider destroyed') ||
            submitErr.message?.includes('UNSUPPORTED_OPERATION') ||
            submitErr.message?.includes('cancelled request') ||
            submitErr.code === 'UNSUPPORTED_OPERATION') {
          console.log('[Validator] Provider/network error during submission - reinitializing connection')
          await initializeConnection()
          // Don't mark as failed, just skip updating these entries so they can be retried
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

      // Update each entry with its actual status
      console.log("[Validator] ========== UPDATING TXQUEUE STATUSES ==========")
      await Promise.all(validatedEntries.map(async (entry, index) => {
        const { succeeded, reason } = finalStatuses[index]
        const data = (entry.payload as any).data

        // Before marking as failed, reload from database to check if another process marked it as done
        if (!succeeded) {
          const currentEntry = await prisma.txQueue.findUnique({
            where: { id: entry.id },
            select: { status: true }
          })

          // If it's already done, skip marking as failed
          if (currentEntry?.status === 'done') {
            console.log(`[Validator] TxQueue #${entry.id} already marked as 'done', skipping failed update`)
            return
          }
        }

        console.log(`[Validator] TxQueue #${entry.id} (${getActionType(data.actionType)} from ${data.senderId}): ${succeeded ? 'SUCCESS' : 'FAILED'} ${reason ? `- ${reason}` : ''}`)

        if (succeeded) {
          await prisma.txQueue.update({
            where: { id: entry.id },
            data: { status: 'done', reason: null }
          })
          // Increment the session key's locally-tracked spent counter so the
          // /api/actions fast-path spend-limit check stays accurate without
          // a live sessionSpent() RPC call per submission.
          await incrementSessionSpent(prisma as any, entry.payload as any, entry.signedTx)
        } else {
          await markTxQueueFailed(entry.id, reason || 'Transaction failed', data.senderId, data)
        }
      }))
      console.log("[Validator] ========== TXQUEUE UPDATE COMPLETE ==========\n")

      // Update caw status for CAW actions that were processed
      await Promise.all(validatedEntries.map(async (entry, index) => {
        const { succeeded, reason } = finalStatuses[index]
        const data = (entry.payload as any).data

        // Check if this is a CAW action
        if (data.actionType === 0 || data.actionType === 'caw') {
          if (succeeded) {
            // Mark caw as SUCCESS and process hashtags
            // Mark caw as SUCCESS
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

              // Only mark as failed if it's not already successful
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
                console.log(`Marked caw as FAILED for user ${data.senderId} cawonce ${data.cawonce}: ${reason}`)
              } else if (existingCaw?.status === 'SUCCESS') {
                console.log(`Caw for user ${data.senderId} cawonce ${data.cawonce} already marked as SUCCESS, skipping failed update`)
              }
            } catch (cawUpdateErr) {
              console.error('Failed to update caw status to FAILED:', cawUpdateErr)
              // Continue even if caw update fails (might not exist)
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
     * Background replication loop. Checks for complete 32-action checkpoints
     * and submits them to archive chains via replicateBatch (multibatch).
     *
     * All data comes from on-chain: reads ActionsProcessed events to get actions,
     * decodes processActions calldata from the transactions to extract signatures.
     */
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
    const replicationHttpProvider = makeJsonRpcProvider(replicationHttpRpcUrl)
    const replicationHttpWallet = new Wallet(privateKey!, replicationHttpProvider)
    console.log(`[Replication] HTTP RPC: ${replicationHttpRpcUrl.slice(0, 50)}...`)

    async function replicationLoop() {
      const replicatorAddress = CAW_ACTIONS_REPLICATOR_L2_ADDRESS

      try {
        // Find clients that have replication enabled (from DB — config synced by ChainSyncService)
        const clients = await prisma.client.findMany({
          where: { replicationEnabled: true, replicationCount: { gt: 0 } },
          select: { id: true, replications: true }
        })

        console.log(`[Replication] Polling: ${clients.length} client(s) with replication enabled`)
        if (clients.length === 0) return

        const httpProvider = replicationHttpProvider
        const httpWallet = replicationHttpWallet

        const CHECKPOINT_INTERVAL = 32
        // ~60KB LZ message size limit — leave headroom for LZ framing overhead
        const LZ_PAYLOAD_LIMIT = 58_000

        const replicatorViewAbi = [
          'function clientActionCount(uint32) view returns (uint256)',
          'function checkpointReplicated(uint32,uint32,uint256) view returns (bool)',
          'function quoteReplicateBatch(uint32,uint256,uint256,uint256,bool) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))',
          'function getNextUnreplicatedCheckpoint(uint32,uint32) view returns (uint256 nextCheckpointId, uint256 totalCheckpoints)',
          'function isAvailableChain(uint32) view returns (bool)',
        ]
        // Read clientActionCount from CawActions (not replicator) to know how
        // many complete checkpoints exist.
        const cawActionsViewAbi = ['function clientActionCount(uint32) view returns (uint256)']
        const cawActionsView = new Contract(CAW_ACTIONS_ADDRESS, cawActionsViewAbi, httpProvider)
        const replicatorView = new Contract(replicatorAddress, replicatorViewAbi, httpProvider)

        const replicatorWriteAbi = [
          // `text` is `bytes` (smltxt-compressed), not `string`. Mismatched
          // ABI produces a different selector and the tx falls into the
          // contract's fallback path (revert with no data at ~2.87M gas).
          'function replicateBatch(tuple(uint32 clientId, uint32 destEid, uint256 startCheckpointId, uint256 endCheckpointId, uint256 lzTokenAmount), bytes packedActions, bytes32[] r) payable',
        ]
        const replicatorWrite = new Contract(replicatorAddress, replicatorWriteAbi, httpWallet)

        for (const client of clients) {
          const replications = client.replications as any[]
          if (!replications?.length) continue

          for (const dest of replications) {
            const destEid = dest.eid
            if (!destEid) continue

            // Skip destinations not registered on the replicator (e.g. self-chain)
            try {
              const available: boolean = await replicatorView.isAvailableChain(destEid)
              if (!available) {
                console.log(`[Replication] Skipping chain ${destEid} — not registered on replicator`)
                continue
              }
            } catch { /* proceed with attempt */ }

            try {
              // Determine how many complete checkpoints exist on the source chain.
              const actionCount = Number(await cawActionsView.clientActionCount(client.id))
              const total = Math.floor(actionCount / CHECKPOINT_INTERVAL)
              if (total === 0) continue

              // Find the first unreplicated checkpoint. Use the on-chain helper
              // when available, falling back to a sequential scan.
              let startCheckpointId = 0
              try {
                const result = await replicatorView.getNextUnreplicatedCheckpoint(client.id, destEid)
                startCheckpointId = Number(result.nextCheckpointId)
              } catch {
                // Fallback: sequential scan
                for (let cp = 1; cp <= total; cp++) {
                  const done = await replicatorView.checkpointReplicated(client.id, destEid, cp)
                  if (!done) { startCheckpointId = cp; break }
                }
              }
              if (startCheckpointId === 0) {
                // All marked done. Check env flag for force-retry of specific checkpoint.
                const forceRetry = Number(process.env.FORCE_REPLICATE_CHECKPOINT || 0)
                if (forceRetry > 0 && forceRetry <= total) {
                  console.log(`[Replication] All checkpoints marked done, but FORCE_REPLICATE_CHECKPOINT=${forceRetry} — retrying`)
                  startCheckpointId = forceRetry
                } else {
                  continue // Fully caught up
                }
              }

              // Find consecutive unreplicated checkpoints starting from startCheckpointId.
              // We'll batch as many as fit within the ~60KB LZ payload limit.
              let endCheckpointId = startCheckpointId
              for (let cp = startCheckpointId + 1; cp <= total; cp++) {
                const done = await replicatorView.checkpointReplicated(client.id, destEid, cp)
                if (done) break // Non-consecutive — stop here
                endCheckpointId = cp
              }

              const numCheckpoints = endCheckpointId - startCheckpointId + 1
              console.log(`[Replication] Client ${client.id} → chain ${destEid}: checkpoints ${startCheckpointId}..${endCheckpointId} (${numCheckpoints}) of ${total} need replication`)

              // Reconstruct actions + signatures from on-chain data for the
              // entire checkpoint range.
              //
              // The hash chain is built by CawActions._processAction in the exact
              // order actions appear in the calldata arrays. Within a block, multiple
              // processActions txs are ordered by transactionIndex. Within a tx,
              // actions are ordered by their position in the calldata array.
              //
              // DB logIndex and rawEventId are NOT reliable for this ordering because
              // safeProcessActions makes external self-calls per action (producing
              // low logIndex events) before emitting the batch ActionsProcessed event.
              const rangeStartPos = (startCheckpointId - 1) * CHECKPOINT_INTERVAL

              // Walk backward from the latest block, accumulating client-
              // action counts per event until we've passed the start of the
              // checkpoint window. This is O(events-since-checkpoint) rather
              // than O(all-events-ever).
              const actionsNeededFromEnd = actionCount - rangeStartPos // how many from tail to cover rangeStartPos
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
                // Count client actions in this batch (newest-first, but we
                // prepend so the final array is oldest-first).
                for (const ev of batch) {
                  const args: any = (ev as any).args
                  if (!args) continue
                  // ActionsProcessed now emits packed bytes — decode to count client actions
                  const packedHexEvt = args[0] || args.packedActions || ''
                  if (packedHexEvt && typeof packedHexEvt === 'string' && packedHexEvt.length > 4) {
                    try {
                      const buf = new Uint8Array((packedHexEvt.startsWith('0x') ? packedHexEvt.slice(2) : packedHexEvt).match(/.{2}/g)!.map((b: string) => parseInt(b, 16)))
                      const actionsArr = unpackActions(buf)
                      for (const a of actionsArr) {
                        if (Number(a.clientId) === client.id) scannedActions++
                      }
                    } catch { /* skip malformed events */ }
                  }
                }
                processedEvents = [...batch, ...processedEvents]
                if (fromBlock === 0) break
                toBlock = fromBlock - 1
              }
              const txHashes = Array.from(new Set(processedEvents.map(e => e.transactionHash)))

              if (txHashes.length === 0) {
                console.log(`[Replication] No ActionsProcessed events found for checkpoints ${startCheckpointId}..${endCheckpointId}, skipping`)
                continue
              }

              // Decode each tx's calldata and build a flat ordered list of actions
              // sorted by (blockNumber, transactionIndex, calldataPosition)
              type OrderedEntry = {
                blockNumber: number; txIndex: number; calldataPos: number
                action: any; v: number; r: string; s: string
              }
              const orderedEntries: OrderedEntry[] = []
              let fetchFailed = false

              for (const txHash of txHashes) {
                const tx = await httpProvider.getTransaction(txHash)
                if (!tx) {
                  console.error(`[Replication] Could not fetch tx ${txHash}`)
                  fetchFailed = true
                  break
                }

                // Decode the packed processActions calldata
                const decoded = packedIface.decodeFunctionData('processActions', tx.data)
                const packedHex: string = decoded[1] // packedActions bytes
                const sigsHex: string = decoded[2]  // sigs bytes

                // Unpack the actions from the packed calldata bytes
                const packedBytes = new Uint8Array((packedHex.startsWith('0x') ? packedHex.slice(2) : packedHex).match(/.{2}/g)!.map(b => parseInt(b, 16)))
                const unpackedActions = unpackActions(packedBytes)

                // Extract signatures
                const sigBytes = new Uint8Array((sigsHex.startsWith('0x') ? sigsHex.slice(2) : sigsHex).match(/.{2}/g)!.map(b => parseInt(b, 16)))

                for (let i = 0; i < unpackedActions.length; i++) {
                  const a = unpackedActions[i]
                  if (a.clientId !== client.id) continue
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

              if (fetchFailed) continue

              // Sort by (blockNumber, transactionIndex, calldataPosition) — this is
              // the exact order the contract built the hash chain
              orderedEntries.sort((a: any, b) => {
                if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber
                if (a.txIndex !== b.txIndex) return a.txIndex - b.txIndex
                return a.calldataPos - b.calldataPos
              })

              // Slice the full range of checkpoints from ordered entries.
              // orderedEntries is a PARTIAL list covering the last N actions
              // (from the backward walk), not the full history. The first entry
              // corresponds to action position (actionCount - orderedEntries.length).
              const firstGlobalPos = actionCount - orderedEntries.length
              const totalActionsNeeded = numCheckpoints * CHECKPOINT_INTERVAL
              const localStart = rangeStartPos - firstGlobalPos
              const rangeEntries = orderedEntries.slice(localStart, localStart + totalActionsNeeded)

              if (rangeEntries.length !== totalActionsNeeded) {
                console.log(`[Replication] Only ${rangeEntries.length}/${totalActionsNeeded} actions reconstructed for checkpoints ${startCheckpointId}..${endCheckpointId} (localStart=${localStart}, entries=${orderedEntries.length}, firstGlobal=${firstGlobalPos}), skipping`)
                continue
              }

              // Deep-clone actions into plain objects — ethers v6 returns frozen
              // Result objects from decodeFunctionData that can't be re-encoded
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

              // Pre-compute the packed payload size and trim endCheckpointId
              // so the total stays under the ~60KB LZ limit. We pack the full
              // range first, then shrink if needed.
              let packedForHash = packActions(allActions.map(a => ({
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

              // Trim checkpoints from the end until we fit within the LZ payload limit
              let actualEndCheckpointId = endCheckpointId
              let actualNumCheckpoints = numCheckpoints
              let actualTotalActions = totalActionsNeeded
              let trimmedAllActions = allActions
              let trimmedAllR = allR

              while (packedForHash.length > LZ_PAYLOAD_LIMIT && actualNumCheckpoints > 1) {
                actualEndCheckpointId--
                actualNumCheckpoints = actualEndCheckpointId - startCheckpointId + 1
                actualTotalActions = actualNumCheckpoints * CHECKPOINT_INTERVAL
                trimmedAllActions = allActions.slice(0, actualTotalActions)
                trimmedAllR = allR.slice(0, actualTotalActions)
                packedForHash = packActions(trimmedAllActions.map(a => ({
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
              }

              if (actualEndCheckpointId !== endCheckpointId) {
                console.log(`[Replication] Trimmed range to ${startCheckpointId}..${actualEndCheckpointId} (${actualNumCheckpoints} checkpoints, ${packedForHash.length} bytes) to fit LZ limit`)
              } else {
                console.log(`[Replication] Payload size: ${packedForHash.length} bytes for ${actualNumCheckpoints} checkpoint(s)`)
              }

              // Use the trimmed values from here on
              trimmedAllActions = trimmedAllActions || allActions
              trimmedAllR = trimmedAllR || allR

              // Pre-flight hash chain verification: recompute the on-chain hash chain
              // locally from (startCheckpointId - 1) to actualEndCheckpointId and compare
              // to the stored checkpoint hash. The chain commits to BOTH r AND
              // keccak256(packedSlice) per action — see CawActions._processAction.
              // Catches ordering and action-body bugs before wasting gas on a revert.
              const hashCheckAbi = ['function clientHashAtCheckpoint(uint32,uint256) view returns (bytes32)']
              const actionsView = new Contract(CAW_ACTIONS_ADDRESS, hashCheckAbi, httpProvider)
              const prevHash = startCheckpointId === 1
                ? '0x' + '00'.repeat(32)
                : await actionsView.clientHashAtCheckpoint(client.id, startCheckpointId - 1)
              const expectedHash = await actionsView.clientHashAtCheckpoint(client.id, actualEndCheckpointId)

              // Hash chain uses keccak256 of the packed action slice (NOT abi.encode).
              // Pack the actions, then slice each one for hashing.
              const actionSlices = getPackedActionSlices(packedForHash)

              let computedHash = prevHash
              for (let i = 0; i < actualTotalActions; i++) {
                const actionHash = keccak256(bytesToHex(actionSlices[i]))
                computedHash = keccak256(solidityPacked(['bytes32', 'bytes32', 'bytes32'], [computedHash, trimmedAllR[i], actionHash]))
              }

              if (computedHash !== expectedHash) {
                console.error(`[Replication] Hash chain mismatch for checkpoints ${startCheckpointId}..${actualEndCheckpointId}! Computed ${computedHash} but on-chain is ${expectedHash}.`)
                console.error(`[Replication]   orderedEntries total: ${orderedEntries.length}, rangeStartPos: ${rangeStartPos}, first action cawonce: ${trimmedAllActions[0]?.cawonce}, last: ${trimmedAllActions[actualTotalActions - 1]?.cawonce}`)
                continue
              }
              console.log(`[Replication] Hash chain verified for checkpoints ${startCheckpointId}..${actualEndCheckpointId}`)

              // Get LZ fee quote — if the payload exceeds LZ's maxMessageSize,
              // log a warning and skip instead of blocking all future checkpoints.
              // The LZ_MessageLib_InvalidMessageSize error selector is 0xc667af3e.
              let nativeFee: bigint
              try {
                const avgTextLength = Math.ceil(trimmedAllActions.reduce((sum: number, a: any) => sum + (a.text?.length || 0), 0) / actualTotalActions)
                const avgRecipients = Math.ceil(trimmedAllActions.reduce((sum: number, a: any) => sum + (a.recipients?.length || 0), 0) / actualTotalActions)
                const fee = await replicatorView.quoteReplicateBatch(destEid, actualNumCheckpoints, avgTextLength, avgRecipients, false)
                // 15% buffer — quoted fee is accurate to a few percent for a
                // given block; 15% is plenty for inter-block drift. (Was 30%
                // briefly; tuned down after confirming quote reliability.)
                nativeFee = BigInt(fee.nativeFee) * 115n / 100n
              } catch (quoteErr: any) {
                const errData = quoteErr?.data || quoteErr?.error?.data || ''
                if (typeof errData === 'string' && errData.startsWith('0xc667af3e')) {
                  console.error(`[Replication] Checkpoints ${startCheckpointId}..${actualEndCheckpointId} payload exceeds LZ message size limit — skipping (will retry if limit is raised)`)
                } else {
                  console.error(`[Replication] Fee quote failed for checkpoints ${startCheckpointId}..${actualEndCheckpointId}:`, quoteErr.message)
                }
                continue
              }

              console.log(`[Replication] Submitting checkpoints ${startCheckpointId}..${actualEndCheckpointId} for client ${client.id} → chain ${destEid} (fee: ${nativeFee} wei)`)

              const params = { clientId: client.id, destEid, startCheckpointId, endCheckpointId: actualEndCheckpointId, lzTokenAmount: 0 }

              // Pre-flight: check that clientChainEnabled is true for this
              // (clientId, destEid). This flag is set on the replicator by a
              // LZ-delivered `setClientChains` message originating from L1.
              // On testnet the LZ DVN queue can stall for hours-to-days, so we
              // log this specifically instead of burying it under "no reason"
              // reverts later in the flow.
              try {
                const enabledAbi = ['function clientChainEnabled(uint32,uint32) view returns (bool)']
                const replEnabledView = new Contract(replicatorAddress, enabledAbi, httpProvider)
                const enabled: boolean = await replEnabledView.clientChainEnabled(client.id, destEid)
                if (!enabled) {
                  console.warn(`[Replication] clientChainEnabled(${client.id}, ${destEid}) = false on replicator ${replicatorAddress}. ` +
                    `Setup LZ message (addReplication → setClientChains) hasn't been delivered yet. ` +
                    `This is typically LZ testnet DVN queue lag — no on-chain action fixes it.`)
                  continue
                }
              } catch (e: any) {
                console.warn(`[Replication] clientChainEnabled pre-check failed: ${e?.shortMessage || e?.message}`)
              }

              const packedForReplication = bytesToHex(packedForHash)
              // Pre-flight staticCall: simulate the tx to surface a revert
              // reason before spending gas. On-chain reverts from replicateBatch
              // have no obvious message in the receipt; this catches contract
              // requires and logs the exact reason instead of the opaque
              // "transaction execution reverted (no reason)".
              try {
                await replicatorWrite.replicateBatch.staticCall(
                  params, packedForReplication, trimmedAllR,
                  { value: nativeFee }
                )
              } catch (simErr: any) {
                const errData = simErr?.data || simErr?.error?.data || simErr?.info?.error?.data
                const decoded = decodeCustomError(errData)
                const reason = simErr?.revert?.args?.[0] || simErr?.reason || simErr?.shortMessage || simErr?.message || 'unknown'

                // "missing revert data" + no errData means the RPC returned
                // nothing useful — common on Infura when eth_call payload is
                // large. Skipping the pre-flight and letting the real tx
                // attempt is safer than blocking replication on an RPC quirk;
                // estimateGas below will also surface any real revert.
                const isNoRevertData = (!errData || errData === '0x') &&
                  (reason.includes('missing revert data') || simErr?.code === 'CALL_EXCEPTION')

                if (decoded) {
                  console.error(`[Replication] Pre-flight simulation failed for checkpoints ${startCheckpointId}..${actualEndCheckpointId} → chain ${destEid}: ${decoded}`)
                  continue
                } else if (isNoRevertData) {
                  console.warn(`[Replication] Pre-flight staticCall returned no data (likely RPC truncation on large calldata) — proceeding to estimateGas which will catch real reverts.`)
                  // Fall through to the estimateGas / submit path
                } else {
                  console.error(`[Replication] Pre-flight simulation failed for checkpoints ${startCheckpointId}..${actualEndCheckpointId} → chain ${destEid}: ${reason}${errData ? ` (raw data: ${errData})` : ''} code=${simErr?.code}`)
                  continue
                }
              }

              // Estimate gas via HTTP and submit with a 10% buffer. Estimates
              // for replicateBatch are deterministic (no oracle reads, no
              // dynamic loops) so 10% is plenty for inter-block storage drift.
              // Cap at 25M to stay below Base's 30M block gas limit.
              let gasLimit: bigint
              try {
                const estimated = await replicatorWrite.replicateBatch.estimateGas(
                  params, packedForReplication, trimmedAllR,
                  { value: nativeFee }
                )
                gasLimit = (estimated * 110n) / 100n
                if (gasLimit > 25_000_000n) gasLimit = 25_000_000n
                console.log(`[Replication] Gas estimated: ${estimated} → using ${gasLimit} (10% buffer)`)
              } catch (gasErr: any) {
                console.warn(`[Replication] estimateGas failed (${gasErr?.shortMessage || gasErr?.message}), using 12M fallback`)
                gasLimit = 12_000_000n
              }

              const tx = await replicatorWrite.replicateBatch(params, packedForReplication, trimmedAllR, {
                value: nativeFee,
                gasLimit,
              })
              let receipt
              try {
                receipt = await tx.wait()
              } catch (waitErr: any) {
                // Out-of-gas reverts arrive here with status=0 and no reason.
                // Surface gasUsed vs gasLimit so it's obvious.
                const r = waitErr?.receipt
                if (r && r.status === 0) {
                  const gasPct = Number((r.gasUsed * 100n) / gasLimit)
                  console.error(`[Replication] Tx ${r.hash} reverted on-chain: status=0, gasUsed=${r.gasUsed}/${gasLimit} (${gasPct}%) — likely ${gasPct >= 95 ? 'OUT OF GAS (raise gasLimit)' : 'contract revert (no reason emitted)'}`)
                }
                throw waitErr
              }
              console.log(`[Replication] Checkpoints ${startCheckpointId}..${actualEndCheckpointId} replicated! tx: ${receipt?.hash} (gas used: ${receipt?.gasUsed}/${gasLimit})`)

              // Record replication analytics
              if (receipt) {
                try {
                  await prisma.replicationTx.create({ data: {
                    txHash: receipt.hash,
                    blockNumber: BigInt(receipt.blockNumber),
                    clientId: client.id,
                    destEid,
                    checkpointId: startCheckpointId,
                    endCheckpointId: actualEndCheckpointId,
                    actionCount: actualTotalActions,
                    gasUsed: receipt.gasUsed.toString(),
                    gasPrice: receipt.fee ? (receipt.fee / receipt.gasUsed).toString() : '0',
                    ethCost: receipt.fee.toString(),
                    lzFee: nativeFee.toString(),
                    totalCost: (receipt.fee + nativeFee).toString(),
                  }})
                } catch (e: any) { console.error('[Analytics] Failed to record replication:', e.message) }
              }
            } catch (err: any) {
              console.error(err)
              console.error(`[Replication] Failed for client ${client.id} → chain ${destEid}: ${formatRpcError(err)}`)
            }
          }
        }
      } catch (err: any) {
        console.error(`[Replication] Loop error: ${formatRpcError(err)}`)
      }
    }

    // ================================================================
    // Optimistic replication: direct L2b submission with stake + fraud proofs
    // ================================================================

    const OPTIMISTIC_ARCHIVE_ADDRESS = '0x360602c0dd788C18240249d4d9ED0451f8bD1ee5'
    const CHALLENGE_RELAY_ADDRESS = '0xb3fF59926e50596C1563BB703455050256E70951'
    const OPTIMISTIC_MIN_STAKE = BigInt('10000000000000000')     // 0.01 ETH
    const OPTIMISTIC_INITIAL_DEPOSIT = BigInt('20000000000000000') // 0.02 ETH
    const OPTIMISTIC_CHECKPOINT_INTERVAL = 32

    const archiveAbi = [
      'function stakes(address) view returns (uint256)',
      'function pendingCount(address) view returns (uint256)',
      'function deposit() payable',
      'function withdraw(uint256)',
      'function submitReplication(uint32 clientId, uint256 startCheckpointId, uint256 endCheckpointId, bytes packedActions, bytes32[] r, bytes32 merkleRoot)',
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
    let l2bWallet: Wallet | null = null
    let archiveRead: Contract | null = null
    let archiveWrite: Contract | null = null

    function getL2bContracts() {
      if (l2bProvider && l2bWallet && archiveRead && archiveWrite) {
        return { l2bProvider, l2bWallet, archiveRead, archiveWrite }
      }
      const l2bRpcUrl = process.env.RPC_ARBITRUM_SEPOLIA
      if (!l2bRpcUrl) throw new Error('RPC_ARBITRUM_SEPOLIA not set — required for optimistic replication')

      l2bProvider = makeJsonRpcProvider(l2bRpcUrl)
      l2bWallet = new Wallet(privateKey!, l2bProvider)
      archiveRead = new Contract(OPTIMISTIC_ARCHIVE_ADDRESS, archiveAbi, l2bProvider)
      archiveWrite = new Contract(OPTIMISTIC_ARCHIVE_ADDRESS, archiveAbi, l2bWallet)

      console.log(`[OptimisticReplication] L2b RPC: ${l2bRpcUrl.slice(0, 50)}...`)
      console.log(`[OptimisticReplication] Archive: ${OPTIMISTIC_ARCHIVE_ADDRESS}`)
      console.log(`[OptimisticReplication] Wallet: ${l2bWallet.address}`)

      return { l2bProvider, l2bWallet, archiveRead, archiveWrite }
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

      return { allActions, allR, packedBytes: packed, checkpointHashes }
    }

    /**
     * Optimistic replication loop: submits checkpoint data directly to L2b
     * archive contract with stake-based security instead of LZ fees per batch.
     */
    async function optimisticReplicationLoop() {
      try {
        const { archiveRead: archive, archiveWrite: archiveW, l2bWallet: w } = getL2bContracts()

        // 1. Check / ensure stake
        const currentStake = BigInt(await archive.stakes(w.address))
        if (currentStake < OPTIMISTIC_MIN_STAKE) {
          console.log(`[OptimisticReplication] Stake ${currentStake} < MIN_STAKE ${OPTIMISTIC_MIN_STAKE}, depositing ${OPTIMISTIC_INITIAL_DEPOSIT}...`)
          const tx = await archiveW.deposit({ value: OPTIMISTIC_INITIAL_DEPOSIT })
          const receipt = await tx.wait()
          console.log(`[OptimisticReplication] Deposited ${OPTIMISTIC_INITIAL_DEPOSIT} wei as stake. tx: ${receipt?.hash}`)
        }

        // 2. Find clients needing replication
        const clients = await prisma.client.findMany({
          where: { replicationEnabled: true, replicationCount: { gt: 0 } },
          select: { id: true }
        })

        if (clients.length === 0) return

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

            const numCheckpoints = endCheckpointId - startCheckpointId + 1
            console.log(`[OptimisticReplication] Client ${client.id}: submitting checkpoints ${startCheckpointId}..${endCheckpointId} (${numCheckpoints})`)

            // 4. Reconstruct data from L2 events
            const data = await reconstructCheckpointData(client.id, startCheckpointId, endCheckpointId)
            if (!data) {
              console.error(`[OptimisticReplication] Failed to reconstruct data for client ${client.id} checkpoints ${startCheckpointId}..${endCheckpointId}`)
              continue
            }

            console.log(`[OptimisticReplication] Hash chain verified for client ${client.id} checkpoints ${startCheckpointId}..${endCheckpointId}`)

            // 5. Build merkle tree over checkpoint hashes
            const checkpointIds = Array.from(
              { length: numCheckpoints },
              (_, i) => startCheckpointId + i
            )
            const { root: merkleRoot } = buildCheckpointMerkleTree(checkpointIds, data.checkpointHashes)
            console.log(`[OptimisticReplication] Merkle root: ${merkleRoot}`)

            // 6. Submit to L2b archive
            const packedHex = bytesToHex(data.packedBytes)

            // Pre-flight simulation
            try {
              await archiveW.submitReplication.staticCall(
                client.id, startCheckpointId, endCheckpointId,
                packedHex, data.allR, merkleRoot
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
                packedHex, data.allR, merkleRoot
              )
              gasLimit = (estimated * 120n) / 100n // 20% buffer for L2b
              if (gasLimit > 30_000_000n) gasLimit = 30_000_000n
            } catch (gasErr: any) {
              console.warn(`[OptimisticReplication] estimateGas failed (${gasErr?.shortMessage || gasErr?.message}), using 15M fallback`)
              gasLimit = 15_000_000n
            }

            const tx = await archiveW.submitReplication(
              client.id, startCheckpointId, endCheckpointId,
              packedHex, data.allR, merkleRoot,
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
                  destEid: 0, // Direct L2b submission, no LZ dest
                  checkpointId: startCheckpointId,
                  endCheckpointId,
                  actionCount: numCheckpoints * OPTIMISTIC_CHECKPOINT_INTERVAL,
                  gasUsed: receipt.gasUsed.toString(),
                  gasPrice: receipt.fee ? (receipt.fee / receipt.gasUsed).toString() : '0',
                  ethCost: receipt.fee?.toString() || '0',
                  lzFee: '0',
                  totalCost: receipt.fee?.toString() || '0',
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
        const { archiveRead: archive, l2bProvider: provider, l2bWallet: w } = getL2bContracts()

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
          try {
            const sub = await archive.getSubmission(submissionId)
            const status = Number(sub[6])
            if (status !== 0) continue // Already finalized or slashed
          } catch { continue }

          // Reconstruct data and verify checkpoint hashes against L2
          try {
            const data = await reconstructCheckpointData(clientId, startCp, endCp)
            if (!data) {
              console.warn(`[Monitor] Could not reconstruct data for submission ${submissionId} (client ${clientId}, ${startCp}..${endCp}) — skipping verification`)
              continue
            }

            // Verify each checkpoint hash against L2's on-chain record
            let fraudDetected = false
            for (let i = 0; i < data.checkpointHashes.length; i++) {
              const cpId = startCp + i
              const localHash = data.checkpointHashes[i]

              let onChainHash: string
              try {
                onChainHash = await actionsView.clientHashAtCheckpoint(clientId, cpId)
              } catch {
                console.warn(`[Monitor] Could not read L2 hash for checkpoint ${cpId}, skipping`)
                continue
              }

              if (localHash.toLowerCase() !== onChainHash.toLowerCase()) {
                console.error(
                  `[Monitor] FRAUD DETECTED in submission ${submissionId}! ` +
                  `Checkpoint ${cpId}: local=${localHash} vs L2=${onChainHash}. ` +
                  `Submitter: ${submitter}. ` +
                  `Challenge relay: ${CHALLENGE_RELAY_ADDRESS}`
                )
                fraudDetected = true
                // TODO: call CawChallengeRelay.relayChallenge on L2, then resolveChallenge on L2b
              }
            }

            if (!fraudDetected) {
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

    const useOptimisticReplication = process.env.REPLICATION_MODE === 'optimistic'

    // Declare all loops with the watchdog. Timeouts are generous — 3x the
    // typical interval — so transient slowness doesn't trigger a restart,
    // but a truly hung loop will be caught within a few minutes.
    ctx.declareLoop('poll', Math.max(checkInterval * 3, 60_000))
    ctx.declareLoop('replication', Math.max(60_000 * 3, 180_000))
    if (useOptimisticReplication) {
      ctx.declareLoop('optimisticReplication', Math.max(60_000 * 3, 180_000))
      ctx.declareLoop('monitor', Math.max(60_000 * 5, 300_000))
    }

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

    // Start background replication loop (LZ-based)
    let isReplicating = false
    let replicationTimer: ReturnType<typeof setInterval>
    const safeReplicationLoop = async () => {
      if (isReplicating) return
      isReplicating = true
      try {
        await replicationLoop()
        ctx.heartbeat('replication')
      } catch (err) {
        console.error('[Replication] Unhandled error:', err)
      } finally {
        isReplicating = false
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
      console.log(`  - Replication Mode: ${useOptimisticReplication ? 'optimistic (stake-based L2b)' : 'lz (LayerZero)'}`)
      console.log(`  - Wallet Address: ${wallet.address}`);

      // Use setTimeout chains instead of setInterval so updated settings take effect immediately
      function schedulePoll() {
        timer = setTimeout(async () => {
          await safePollLoop()
          schedulePoll()
        }, liveSettings.checkInterval)
      }
      function scheduleReplication() {
        replicationTimer = setTimeout(async () => {
          await safeReplicationLoop()
          scheduleReplication()
        }, liveSettings.replicationInterval)
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

      // Start the appropriate replication mode(s)
      if (useOptimisticReplication) {
        console.log('[OptimisticReplication] Starting optimistic replication and monitor loops')
        safeOptimisticReplicationLoop()
        scheduleOptimisticReplication()
        safeMonitorLoop()
        scheduleMonitor()
      } else {
        safeReplicationLoop()
        scheduleReplication()
      }
    })

    return {
      started: Promise.resolve(),
      async stop() {
        clearTimeout(timer)
        clearTimeout(replicationTimer)
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


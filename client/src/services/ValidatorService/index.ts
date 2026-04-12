// src/services/ValidatorService/index.ts

import { z } from 'zod'
import 'dotenv/config'
import { Service } from '../../Service'
import { prisma }  from '../../prismaClient'
import getActionType from '../../abi/getActionType'
import { cawActionsAbi } from '../../abi/generated'
import { CAW_ACTIONS_ADDRESS, CAW_ACTIONS_REPLICATOR_L2_ADDRESS, CAW_ADDRESS, WETH_ADDRESS } from '../../abi/addresses'
import { WebSocketProvider, JsonRpcProvider, Contract, Wallet } from 'ethers'
import { cawToEthCached, isPriceFresh } from '../ChainSyncService'
import { markTxQueueFailed as sharedMarkTxQueueFailed } from '../../utils/txQueueFailure'

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
    cachedMainnetProvider = new JsonRpcProvider(mainnetRpcUrl)
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
        provider = new WebSocketProvider(l2RpcUrl)

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

        wallet = new Wallet(privateKey, provider)
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

      return prisma.txQueue.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        take: 256
      })
    }

    /** natstat: split each raw signedTx into r, s, v and collect action payloads */
    function buildMultiActionData(
      queueEntries: Array<{ payload: any; signedTx: string }>
    ) {
      const actions: any[]    = []
      const v: number[] = []
      const r: string[] = []
      const s: string[] = []

      for (const entry of queueEntries) {
        const signature = entry.signedTx
        const hex = signature.startsWith('0x') ? signature.slice(2) : signature

        r.push('0x' + hex.slice(0, 64))
        s.push('0x' + hex.slice(64, 128))
        v.push(parseInt(hex.slice(128, 130), 16))

        // Ensure amounts are properly formatted as strings
        const actionData = (entry.payload as any).data
        const sanitizedAction = {
          ...actionData,
          amounts: Array.isArray(actionData.amounts)
            ? actionData.amounts.map((amt: any) => {
                // Convert to string and validate
                if (amt === null || amt === undefined || amt === '') {
                  return '0'
                }
                // Ensure it's a valid number string
                const strAmt = String(amt)
                if (strAmt === 'NaN' || isNaN(Number(strAmt))) {
                  console.warn(`Invalid amount value: ${amt}, defaulting to 0`)
                  return '0'
                }
                return strAmt
              })
            : []
        }

        actions.push(sanitizedAction)
      }

      return { actions, v, r, s }
    }


    async function simulateActions(
      validatorId: number,
      multiData: { actions: any[]; v: number[]; r: string[]; s: string[] },
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
          calldata = iface.encodeFunctionData('safeProcessActions', [
            validatorId,
            { actions: multiData.actions, v: multiData.v, r: multiData.r, s: multiData.s },
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

        // Add timeout wrapper to prevent hanging
        console.log(`[Validator] Calling provider.call() to ${CAW_ACTIONS_ADDRESS} with value ${quote?.nativeFee?.toString() || '0'}`)
        const callPromise = provider.call({
          to: CAW_ACTIONS_ADDRESS,
          data: calldata,
          value: quote?.nativeFee
        })

        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('RPC call timeout after 15 seconds')), 15000)
        })

        let returnData: string
        try {
          console.log("[Validator] Awaiting RPC response (15s timeout)...")
          returnData = await Promise.race([callPromise, timeoutPromise]) as string
          console.log(`[Validator] RPC call returned data (${returnData?.length || 0} chars)`)
        } catch (timeoutErr: any) {
          console.error('[Validator] RPC call timeout or error:', timeoutErr.message)
          console.error('[Validator] Full timeout error:', timeoutErr)

          // If timeout, reinitialize the WebSocket connection
          if (timeoutErr.message?.includes('timeout')) {
            console.log('[Validator] Timeout detected - reinitializing WebSocket connection')
            initializeConnection()
          }

          throw timeoutErr
        }

        const elapsed = Date.now() - startTime;

        console.log(`[Validator] Step 6: Decoding response...`)
        console.log(`Simulation completed in ${elapsed}ms`)
        const decoded = iface.decodeFunctionResult(
          'safeProcessActions',
          returnData
        ) as [ any[], string[] ]  // [ successfulActions, rejectionMessages ]
        console.log("decoded", decoded)

        const [ successfulActions, rejectionMessages ] = decoded

        console.log("simulated:", successfulActions.length, rejectionMessages)
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
      multiData: { actions: any[]; v: number[]; r: string[]; s: string[] },
      quote: { nativeFee: bigint; withdrawFee: bigint; withdrawLzTokenAmount: bigint }
    ) {
      const calldata = iface.encodeFunctionData('processActions', [
        validatorId,
        { actions: multiData.actions, v: multiData.v, r: multiData.r, s: multiData.s },
        quote.withdrawFee,
        quote.withdrawLzTokenAmount,
      ])

      const gasLimitRaw = await provider.estimateGas({
        to:    CAW_ACTIONS_ADDRESS,
        data:  calldata,
        value: quote.nativeFee
      })

      const feeData = await provider.getFeeData()
      const gasPrice = feeData.gasPrice ?? BigInt(0)

      return gasLimitRaw * gasPrice;
    }


    /** natstat: estimate the raw gas‐limit for processActions */
    async function estimateGasLimit(
      validatorId: number,
      multiData: { actions: any[]; v: number[]; r: string[]; s: string[] },
      quote: { nativeFee: bigint; withdrawFee: bigint; withdrawLzTokenAmount: bigint }
    ): Promise<bigint> {
      // 1) ABI-encode the same calldata you'd send on-chain
      const calldata = iface.encodeFunctionData('processActions', [
        validatorId,
        { actions: multiData.actions, v: multiData.v, r: multiData.r, s: multiData.s },
        quote.withdrawFee,
        quote.withdrawLzTokenAmount,
      ]);

      // 2) Ask the provider directly for the gas estimate
      const estimate = await provider.estimateGas({
        to:             CAW_ACTIONS_ADDRESS,
        data:           calldata,
        value:          quote.nativeFee,
      });

      return estimate;
    }


    async function submitProcessActions(
      validatorId: number,
      multiData: { actions: any[]; v: number[]; r: string[]; s: string[] },
      quote: { nativeFee: bigint; withdrawFee: bigint; withdrawLzTokenAmount: bigint },
      rawGasLimit: bigint,
      retryCount: number = 0
    ) {
      const maxRetries = 3
      const gasBumpPercent = 15 // Increase gas by 15% on each retry

      console.log("will submit ", multiData.actions.length, multiData)
      console.log("[submitProcessActions] Getting fee data..." + (retryCount > 0 ? ` (retry ${retryCount}/${maxRetries})` : ''))
      const feeData = await provider.getFeeData();

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
        const txData = iface.encodeFunctionData('processActions', [
          validatorId,
          { actions: multiData.actions, v: multiData.v, r: multiData.r, s: multiData.s },
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

        console.log("[submitProcessActions] ActionsProcessed event found:", evt.args)
        const processed = (evt.args.actions as any[]).map(a => ({
          senderId:     Number(a.senderId),
          cawonce:      Number(a.cawonce)
        }))
        console.log("[submitProcessActions] Processed actions:", processed)
        return { processed, receipt }
      } catch (err: any) {
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
      multiData: { actions: any[]; v: number[]; r: string[]; s: string[] }
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
        successfulActions.map(a => `${a.senderId}-${a.cawonce}`)
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
     * Background replication loop. Checks for complete 256-action checkpoints
     * and submits them to archive chains via replicateBatch.
     *
     * All data comes from on-chain: reads ActionsProcessed events to get actions,
     * decodes processActions calldata from the transactions to extract signatures.
     */
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

        const replicatorViewAbi = [
          'function getNextUnreplicatedCheckpoint(uint32,uint32) view returns (uint256,uint256)',
          'function quoteReplicateBatch(uint32,uint256,bool) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))',
        ]
        const replicatorView = new Contract(replicatorAddress, replicatorViewAbi, provider)

        const replicatorWriteAbi = [
          'function replicateBatch(tuple(uint32 clientId, uint32 destEid, uint256 checkpointId, uint256 lzTokenAmount), tuple(uint8 actionType, uint32 senderId, uint32 receiverId, uint32 receiverCawonce, uint32 clientId, uint32 cawonce, uint32[] recipients, uint64[] amounts, string text)[], uint8[], bytes32[], bytes32[]) payable',
        ]
        const replicatorWrite = new Contract(replicatorAddress, replicatorWriteAbi, wallet)

        for (const client of clients) {
          const replications = client.replications as any[]
          if (!replications?.length) continue

          for (const dest of replications) {
            const destEid = dest.eid
            if (!destEid) continue

            try {
              const [nextCheckpointId, totalCheckpoints] = await replicatorView.getNextUnreplicatedCheckpoint(client.id, destEid)
              const checkpointId = Number(nextCheckpointId)
              const total = Number(totalCheckpoints)

              console.log(`[Replication] Client ${client.id} → chain ${destEid}: getNextUnreplicatedCheckpoint returned checkpointId=${checkpointId}, total=${total}`)

              if (checkpointId === 0) continue // Fully caught up

              console.log(`[Replication] Client ${client.id} → chain ${destEid}: checkpoint ${checkpointId}/${total} needs replication`)

              // Reconstruct the 256 actions + signatures from on-chain data.
              // We read processActions tx calldata from the RawEvent table (which stores
              // the transactionHash for each ActionsProcessed event) and decode it.
              const startPos = (checkpointId - 1) * 256

              // Find Action records for this client in the checkpoint range, ordered by id
              // (auto-increment, which preserves on-chain processing order since RawEventsGatherer
              // processes events in blockNumber+logIndex order and ActionProcessor inserts sequentially)
              const actionsInRange = await prisma.action.findMany({
                where: {
                  data: { path: ['clientId'], equals: client.id }
                },
                orderBy: { id: 'asc' },
                include: { rawEvent: { select: { transactionHash: true } } },
                skip: startPos,
                take: 256,
              })

              if (actionsInRange.length !== 256) {
                console.log(`[Replication] Only ${actionsInRange.length}/256 actions indexed for checkpoint ${checkpointId}, skipping`)
                continue
              }

              // Cache decoded tx calldata per txHash. A single processActions tx can contain
              // multiple actions (potentially across different clients, and potentially
              // straddling the 256-action checkpoint boundary), so we must match each DB row
              // to its SPECIFIC action in the calldata — not just merge everything.
              type DecodedEntry = { action: any; v: number; r: string; s: string }
              const txCache = new Map<string, Map<string, DecodedEntry>>() // txHash → (senderId:cawonce → entry)
              const uniqueTxHashes = Array.from(new Set(
                actionsInRange.map(a => a.rawEvent?.transactionHash).filter(Boolean) as string[]
              ))

              let fetchFailed = false
              for (const txHash of uniqueTxHashes) {
                const tx = await provider.getTransaction(txHash)
                if (!tx) {
                  console.error(`[Replication] Could not fetch tx ${txHash}`)
                  fetchFailed = true
                  break
                }

                const decoded = iface.decodeFunctionData('processActions', tx.data)
                const multiData = decoded[1] // The MultiActionData struct
                const txActions = multiData.actions
                const txV = multiData.v
                const txR = multiData.r
                const txS = multiData.s

                // Index entries by (senderId, cawonce) — unique per action
                const entriesByKey = new Map<string, DecodedEntry>()
                for (let i = 0; i < txActions.length; i++) {
                  const a = txActions[i]
                  // Only index entries for this client — keeps the map tight
                  if (Number(a.clientId) !== client.id) continue
                  const key = `${Number(a.senderId)}:${Number(a.cawonce)}`
                  entriesByKey.set(key, {
                    action: a,
                    v: Number(txV[i]),
                    r: txR[i],
                    s: txS[i],
                  })
                }
                txCache.set(txHash, entriesByKey)
              }

              if (fetchFailed) continue

              // Walk DB rows in order, pulling the matching calldata entry for each.
              // This guarantees exactly 256 actions in the correct on-chain order.
              const allActions: any[] = []
              const allV: number[] = []
              const allR: string[] = []
              const allS: string[] = []
              let reconstructionOk = true

              for (const row of actionsInRange) {
                const txHash = row.rawEvent?.transactionHash
                if (!txHash) {
                  console.error(`[Replication] Action row ${row.id} missing rawEvent.transactionHash, skipping checkpoint`)
                  reconstructionOk = false
                  break
                }
                const entriesByKey = txCache.get(txHash)
                if (!entriesByKey) {
                  console.error(`[Replication] Missing decoded tx ${txHash} for action row ${row.id}`)
                  reconstructionOk = false
                  break
                }
                const key = `${row.senderId}:${row.cawonce}`
                const entry = entriesByKey.get(key)
                if (!entry) {
                  console.error(`[Replication] No calldata match for action row ${row.id} (key ${key}) in tx ${txHash}`)
                  reconstructionOk = false
                  break
                }
                allActions.push(entry.action)
                allV.push(entry.v)
                allR.push(entry.r)
                allS.push(entry.s)
              }

              if (!reconstructionOk) continue

              if (allActions.length !== 256) {
                console.log(`[Replication] Reconstructed ${allActions.length}/256 actions from calldata, skipping`)
                continue
              }

              // Get LZ fee quote
              const avgTextLength = Math.ceil(allActions.reduce((sum: number, a: any) => sum + (a.text?.length || 0), 0) / 256)
              const fee = await replicatorView.quoteReplicateBatch(destEid, avgTextLength, false)
              const nativeFee = BigInt(fee.nativeFee) * 110n / 100n // 10% buffer

              console.log(`[Replication] Submitting checkpoint ${checkpointId} for client ${client.id} → chain ${destEid} (fee: ${nativeFee} wei)`)

              const params = { clientId: client.id, destEid, checkpointId, lzTokenAmount: 0 }
              const tx = await replicatorWrite.replicateBatch(params, allActions, allV, allR, allS, { value: nativeFee })
              const receipt = await tx.wait()
              console.log(`[Replication] Checkpoint ${checkpointId} replicated! tx: ${receipt?.hash}`)

              // Record replication analytics
              if (receipt) {
                try {
                  await prisma.replicationTx.create({ data: {
                    txHash: receipt.hash,
                    blockNumber: BigInt(receipt.blockNumber),
                    clientId: client.id,
                    destEid,
                    checkpointId,
                    actionCount: 256,
                    gasUsed: receipt.gasUsed.toString(),
                    gasPrice: receipt.fee ? (receipt.fee / receipt.gasUsed).toString() : '0',
                    ethCost: receipt.fee.toString(),
                    lzFee: nativeFee.toString(),
                    totalCost: (receipt.fee + nativeFee).toString(),
                  }})
                } catch (e: any) { console.error('[Analytics] Failed to record replication:', e.message) }
              }
            } catch (err: any) {
              console.error(`[Replication] Failed for client ${client.id} → chain ${destEid}:`, err.message)
            }
          }
        }
      } catch (err: any) {
        console.error('[Replication] Loop error:', err.message)
      }
    }

    // Declare both loops with the watchdog. Timeouts are generous — 3× the
    // typical interval — so transient slowness doesn't trigger a restart,
    // but a truly hung loop will be caught within a few minutes.
    ctx.declareLoop('poll', Math.max(checkInterval * 3, 60_000))
    ctx.declareLoop('replication', Math.max(60_000 * 3, 180_000))

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

    // Start background replication loop
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

    // Load DB settings before first poll (env/config values serve as defaults).
    // Settings are also refreshed at the start of every poll cycle.
    refreshSettings(checkInterval).catch(err => {
      console.error('[Validator] refreshSettings failed, continuing with defaults:', err.message)
    }).then(() => {
      console.log(`[Validator] Starting validator service with:`);
      console.log(`  - L2 RPC URL: ${l2RpcUrl}`);
      console.log(`  - ETH Mainnet RPC URL: ${ethMainnetRpcUrl}`);
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
      function scheduleReplication() {
        replicationTimer = setTimeout(async () => {
          await safeReplicationLoop()
          scheduleReplication()
        }, liveSettings.replicationInterval)
      }
      safePollLoop()
      schedulePoll()
      safeReplicationLoop()
      scheduleReplication()
    })

    return {
      started: Promise.resolve(),
      async stop() {
        clearTimeout(timer)
        clearTimeout(replicationTimer)
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


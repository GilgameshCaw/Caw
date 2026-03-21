// src/services/ValidatorService/index.ts

import { z } from 'zod'
import 'dotenv/config'
import { Service } from '../../Service'
import { prisma }  from '../../prismaClient'
import getActionType from '../../abi/getActionType'
import { cawActionsAbi, cawClientManagerAbi } from '../../abi/generated'
import { CAW_ACTIONS_ADDRESS, CAW_ADDRESS, WETH_ADDRESS, CLIENT_MANAGER_ADDRESS } from '../../abi/addresses'
import { WebSocketProvider, JsonRpcProvider, Contract, Wallet } from 'ethers'
import { cawToEthCached, isPriceFresh, getReplicationCount as getReplicationCountFromCache } from '../ChainSyncService'

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

// Cache for ClientManager contract (L2)
let cachedClientManager: Contract | null = null
let cachedL2Provider: JsonRpcProvider | null = null

// Cache for replication counts (clientId -> count) - refreshes every 5 minutes
const replicationCountCache: Map<number, { count: number; timestamp: number }> = new Map()
const REPLICATION_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

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

/**
 * Get or create ClientManager contract instance
 * Uses L2_RPC_URL_HTTP for JSON-RPC calls (WebSocket URLs don't work with JsonRpcProvider)
 */
function getClientManager(): Contract {
  if (!cachedClientManager || !cachedL2Provider) {
    // Use HTTP URL for JsonRpcProvider (WebSocket URL won't work)
    const l2HttpUrl = process.env.L2_RPC_URL_HTTP
    if (!l2HttpUrl) {
      throw new Error('Missing L2_RPC_URL_HTTP in environment variables')
    }
    cachedL2Provider = new JsonRpcProvider(l2HttpUrl)
    cachedClientManager = new Contract(CLIENT_MANAGER_ADDRESS, cawClientManagerAbi, cachedL2Provider)
  }
  return cachedClientManager
}

/**
 * Get replication count for a client
 * Uses ChainSyncService cache first, falls back to direct contract query
 * @param clientId - The client ID
 * @returns Number of replication destinations for this client
 */
async function getReplicationCount(clientId: number): Promise<number> {
  // Try ChainSyncService cache first (synced every 30 minutes)
  try {
    const cachedCount = await getReplicationCountFromCache(clientId)
    // If we got a result from DB, use it
    if (cachedCount !== undefined) {
      return cachedCount
    }
  } catch (err) {
    // Cache miss, continue to direct query
  }

  // Check local memory cache
  const cached = replicationCountCache.get(clientId)
  if (cached && Date.now() - cached.timestamp < REPLICATION_CACHE_TTL) {
    return cached.count
  }

  // Fallback to direct contract query
  try {
    const clientManager = getClientManager()

    // Check if replication is enabled for this client
    const enabled = await clientManager.clientReplicationEnabled(clientId)
    if (!enabled) {
      replicationCountCache.set(clientId, { count: 0, timestamp: Date.now() })
      return 0
    }

    const count = Number(await clientManager.getReplicationCount(clientId))

    // Cache the result
    replicationCountCache.set(clientId, { count, timestamp: Date.now() })

    console.log(`[Validator] Replication count for client ${clientId}: ${count}`)
    return count
  } catch (error: any) {
    console.error('[Validator] Failed to get replication count:', error.message)
    // Fallback to 0 if we can't query the contract
    return 0
  }
}

// Tip constants - must match frontend actions.ts
// These are in whole CAW tokens (contract multiplies by 10^18 on-chain)
// At ~500k CAW = $0.01, 1k CAW ≈ $0.00002 per action
const BASE_VALIDATOR_TIP = BigInt(process.env.VALIDATOR_BASE_TIP || "1000") // 1k CAW base tip
const TIP_PER_REPLICATION_CHAIN = BigInt(process.env.VALIDATOR_TIP_PER_CHAIN || "500") // 500 CAW per replication chain

/**
 * Calculate the minimum required tip for an action based on replication chain count
 * @param replicationChainCount - Number of replication destinations for the client
 * @returns Minimum required tip in CAW
 */
function calculateMinimumTip(replicationChainCount: number): bigint {
  return BASE_VALIDATOR_TIP + (TIP_PER_REPLICATION_CHAIN * BigInt(replicationChainCount))
}

/**
 * Validate that an action's tip is sufficient for the client's replication count
 * @param action - The action data
 * @param l2RpcUrl - L2 RPC URL for contract query
 * @returns Validation result with details
 */
async function validateActionTip(
  action: any,
  l2RpcUrl: string
): Promise<{ valid: boolean; reason?: string; required?: bigint; provided?: bigint }> {
  const clientId = action.clientId ?? 1
  const replicationCount = await getReplicationCount(clientId)

  // Get the tip from the action's amounts array (last element is the tip)
  const amounts = action.amounts || []
  if (amounts.length === 0) {
    return {
      valid: false,
      reason: `No tip provided. Required: ${calculateMinimumTip(replicationCount).toString()} CAW`,
      required: calculateMinimumTip(replicationCount),
      provided: BigInt(0)
    }
  }

  const providedTip = BigInt(amounts[amounts.length - 1] || '0')
  const requiredTip = calculateMinimumTip(replicationCount)

  if (providedTip < requiredTip) {
    console.log(`[Validator] Insufficient tip for action:`)
    console.log(`  - Client ID: ${clientId}`)
    console.log(`  - Replication chains: ${replicationCount}`)
    console.log(`  - Required tip: ${requiredTip.toString()} CAW`)
    console.log(`  - Provided tip: ${providedTip.toString()} CAW`)
    return {
      valid: false,
      reason: `Insufficient tip: provided ${providedTip.toString()} CAW, required ${requiredTip.toString()} CAW (base + ${replicationCount} chains)`,
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

  start(rawCfg) {
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

        // Get replication quote for each unique client
        // For simulation, we need to estimate the total replication cost across all clients
        console.log("[Validator] Step 2: Getting replication quotes...")
        const uniqueClientIds = getUniqueClientIds(multiData.actions)
        console.log(`[Validator] Unique client IDs: ${uniqueClientIds.join(', ')}`)
        let totalReplicationFee = BigInt(0)
        let totalReplicationLzToken = BigInt(0)

        for (const clientId of uniqueClientIds) {
          console.log(`[Validator] Getting replication quote for client ${clientId}...`)
          try {
            // Get actions for this client to build payload for quote
            const clientActions = multiData.actions.filter((a: any) => (a.clientId ?? 1) === clientId)
            const clientIndices = multiData.actions.map((a: any, i: number) => (a.clientId ?? 1) === clientId ? i : -1).filter(i => i >= 0)
            const clientData = {
              actions: clientActions,
              v: clientIndices.map(i => multiData.v[i]),
              r: clientIndices.map(i => multiData.r[i]),
              s: clientIndices.map(i => multiData.s[i])
            }
            console.log(`[Validator] Calling cawActions.replicationQuote(${clientId}, ...)`)

            // Add timeout to replicationQuote call
            const quotePromise = cawActions.replicationQuote(clientId, clientData, false)
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error('replicationQuote timeout after 10s')), 10000)
            })
            const replicationQuote = await Promise.race([quotePromise, timeoutPromise]) as any
            console.log(`[Validator] Got replication quote response:`, replicationQuote)
            if (replicationQuote && replicationQuote.quote) {
              totalReplicationFee += BigInt(replicationQuote.quote.nativeFee || 0)
              totalReplicationLzToken += BigInt(replicationQuote.quote.lzTokenFee || 0)
              console.log(`[Validator] Replication quote for client ${clientId}: nativeFee=${replicationQuote.quote.nativeFee}, chainCount=${replicationQuote.chainCount}`)
            }
          } catch (err: any) {
            // Replication might not be configured for this client - that's OK
            // Also catch timeouts gracefully
            console.log(`[Validator] Replication quote error for client ${clientId}:`, err.message)

            // If timeout, reinitialize connection for next attempt
            if (err.message?.includes('timeout')) {
              console.log('[Validator] Replication quote timeout - reinitializing connection')
              initializeConnection()
            }

            if (!err.message?.includes('Replicator not set')) {
              console.log(`[Validator] Failed to get replication quote for client ${clientId}:`, err.message)
            }
          }
        }
        console.log("[Validator] Step 2 complete: replication quotes retrieved")

        // Total native fee = withdraw fee + replication fee
        const totalNativeFee = BigInt(withdrawQuote.nativeFee || 0) + totalReplicationFee

        // Build the quote object with all fees
        const quote = {
          nativeFee: totalNativeFee,
          withdrawFee: BigInt(withdrawQuote.nativeFee || 0),
          withdrawLzTokenAmount: BigInt(withdrawQuote.lzTokenFee || 0),
          replicationFee: totalReplicationFee,
          replicationLzTokenAmount: totalReplicationLzToken
        }

        console.log("[Validator] Step 3: Building quote object...")
        console.log("[Validator] Total fees:", {
          withdrawFee: quote.withdrawFee.toString(),
          replicationFee: quote.replicationFee.toString(),
          totalNativeFee: quote.nativeFee.toString()
        })

        // ABI‐encode with the new 5-argument signature
        console.log("[Validator] Step 4: Encoding calldata...")
        let calldata: string
        try {
          calldata = iface.encodeFunctionData('safeProcessActions', [
            validatorId,
            { actions: multiData.actions, v: multiData.v, r: multiData.r, s: multiData.s },
            quote.withdrawFee,
            quote.withdrawLzTokenAmount,
            quote.replicationLzTokenAmount
          ])
          console.log(`[Validator] Calldata encoded successfully (${calldata.length} chars)`)
        } catch (encodeErr: any) {
          console.error(`[Validator] FAILED to encode calldata:`, encodeErr.message)
          throw encodeErr
        }
        console.log(`Call data prepared, simulating transaction...`)
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
      quote: { nativeFee: bigint; withdrawFee: bigint; withdrawLzTokenAmount: bigint; replicationFee: bigint; replicationLzTokenAmount: bigint }
    ) {
      const calldata = iface.encodeFunctionData('processActions', [
        validatorId,
        { actions: multiData.actions, v: multiData.v, r: multiData.r, s: multiData.s },
        quote.withdrawFee,
        quote.withdrawLzTokenAmount,
        quote.replicationLzTokenAmount
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
      quote: { nativeFee: bigint; withdrawFee: bigint; withdrawLzTokenAmount: bigint; replicationFee: bigint; replicationLzTokenAmount: bigint }
    ): Promise<bigint> {
      // 1) ABI-encode the same calldata you'd send on-chain
      const calldata = iface.encodeFunctionData('processActions', [
        validatorId,
        { actions: multiData.actions, v: multiData.v, r: multiData.r, s: multiData.s },
        quote.withdrawFee,
        quote.withdrawLzTokenAmount,
        quote.replicationLzTokenAmount
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
      quote: { nativeFee: bigint; withdrawFee: bigint; withdrawLzTokenAmount: bigint; replicationFee: bigint; replicationLzTokenAmount: bigint },
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
        replicationFee: quote.replicationFee.toString(),
        gasLimit: rawGasLimit.toString()
      })

      try {
        // sendTransaction with full 5-argument signature
        const tx = await wallet.sendTransaction({
          to:    CAW_ACTIONS_ADDRESS,
          data:  iface.encodeFunctionData('processActions', [
            validatorId,
            { actions: multiData.actions, v: multiData.v, r: multiData.r, s: multiData.s },
            quote.withdrawFee,
            quote.withdrawLzTokenAmount,
            quote.replicationLzTokenAmount
          ]),
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
        return processed
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

        throw err
      }
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

        // Treat "Cawonce already used" as success — another validator already processed it
        const rejection = simulationRejections[index] || ''
        const processedByOther = rejection.includes('Cawonce already used')

        const newStatus = succeededKeys.has(key) || processedByOther
          ? 'done'
          : 'failed'

        // Get the rejection reason for this specific entry
        const reason = newStatus === 'failed' && simulationRejections[index]
          ? simulationRejections[index]
          : undefined

        console.log("new status", newStatus, reason ? `with reason: ${reason}` : '')

        // Update TxQueue status
        await prisma.txQueue.update({
          where: { id: entry.id },
          data:  {
            status: newStatus,
            ...(reason ? { reason } : {})
          }
        })

        // If the TxQueue entry failed and it's a CAW action, mark the Caw as failed
        if (newStatus === 'failed' && (data.actionType === 0 || data.actionType === 'caw')) {
          try {
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
          } catch (cawUpdateErr) {
            console.error('Failed to update caw status to FAILED:', cawUpdateErr)
            // Continue even if caw update fails (might not exist)
          }
        } else if (newStatus === 'done' && (data.actionType === 0 || data.actionType === 'caw')) {
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
    ): Promise<{ nativeFee: bigint; withdrawFee: bigint; withdrawLzTokenAmount: bigint; replicationFee: bigint; replicationLzTokenAmount: bigint }> {
      // Get withdrawal quote
      const withdraws = multiData.actions.filter((action: any) => getActionType(action.actionType).toString() === 'WITHDRAW')
      let withdrawQuote = { nativeFee: BigInt(0), lzTokenFee: BigInt(0) }
      if (withdraws.length > 0) {
        const tokenIds = withdraws.map((action: any) => action.senderId)
        // Convert amounts from whole CAW units to wei (action struct uses uint64, so amounts are not in wei)
        const amounts = withdraws.map((action: any) => BigInt(action.amounts[0]) * 10n**18n)
        try {
          withdrawQuote = await cawActions.withdrawQuote(tokenIds, amounts, false) as any
        } catch (err) {
          console.error("[Validator] Failed to get withdraw quote:", err)
        }
      }

      // Get replication quote for each unique client
      const uniqueClientIds = getUniqueClientIds(multiData.actions)
      let totalReplicationFee = BigInt(0)
      let totalReplicationLzToken = BigInt(0)

      for (const clientId of uniqueClientIds) {
        try {
          const clientActions = multiData.actions.filter((a: any) => (a.clientId ?? 1) === clientId)
          const clientIndices = multiData.actions.map((a: any, i: number) => (a.clientId ?? 1) === clientId ? i : -1).filter(i => i >= 0)
          const clientData = {
            actions: clientActions,
            v: clientIndices.map(i => multiData.v[i]),
            r: clientIndices.map(i => multiData.r[i]),
            s: clientIndices.map(i => multiData.s[i])
          }

          const replicationQuote = await cawActions.replicationQuote(clientId, clientData, false) as any
          if (replicationQuote && replicationQuote.quote) {
            totalReplicationFee += BigInt(replicationQuote.quote.nativeFee || 0)
            totalReplicationLzToken += BigInt(replicationQuote.quote.lzTokenFee || 0)
          }
        } catch (err: any) {
          if (!err.message?.includes('Replicator not set')) {
            console.log(`[Validator] Failed to get replication quote for client ${clientId}:`, err.message)
          }
        }
      }

      return {
        nativeFee: BigInt(withdrawQuote.nativeFee || 0) + totalReplicationFee,
        withdrawFee: BigInt(withdrawQuote.nativeFee || 0),
        withdrawLzTokenAmount: BigInt(withdrawQuote.lzTokenFee || 0),
        replicationFee: totalReplicationFee,
        replicationLzTokenAmount: totalReplicationLzToken
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

      // Parse the text to check for base64 images
      const imageMatches = text.match(/image64:([^\n]+)/g)
      if (!imageMatches || imageMatches.length === 0) {
        return { valid: true }
      }

      // Get clientId from action to determine replication chain count
      const clientId = action.clientId ?? 1 // Default to client 1 if not specified
      const replicationChainCount = await getReplicationCount(clientId)

      // Calculate required CAW for all images
      let totalRequiredCaw = 0
      for (const match of imageMatches) {
        const base64Data = match.replace('image64:', '')
        // Base64 encoding increases size by ~33%
        const originalSize = Math.ceil((base64Data.length * 3) / 4)

        // L2 storage cost calculation (same as frontend)
        const MIN_CAW_COST = 500
        const l1GasPerByte = 16
        const l1DataGas = originalSize * l1GasPerByte
        const l2ExecutionGas = originalSize * 3
        const totalGas = l1DataGas + l2ExecutionGas
        const effectiveGasPrice = 8
        const cawPerGwei = 0.03
        const baseCost = Math.ceil(totalGas * effectiveGasPrice * cawPerGwei)
        const l2Cost = Math.ceil(baseCost * 2.5) // Match frontend 2.5x markup

        // Replication cost calculation (cross-chain replication)
        // Query actual replication chain count from contract
        let archiveCost = 0
        if (replicationChainCount > 0) {
          const BASE_LZ_FEE_GWEI = 500000 // ~0.0005 ETH base fee per chain
          const ARCHIVE_GAS_LIMIT = 50000
          const dataGas = originalSize * l1GasPerByte
          const totalGasPerChain = ARCHIVE_GAS_LIMIT + Math.min(dataGas, 100000)
          const archiveGasPrice = 5
          const executionCost = totalGasPerChain * archiveGasPrice
          const perChainCostGwei = BASE_LZ_FEE_GWEI + executionCost
          const perChainCostCaw = Math.ceil(perChainCostGwei * cawPerGwei)
          archiveCost = Math.ceil(perChainCostCaw * replicationChainCount * 1.5) // 50% buffer
        }

        const totalCost = l2Cost + archiveCost
        totalRequiredCaw += Math.max(MIN_CAW_COST, totalCost)
      }

      // Check if amounts array has sufficient CAW
      const amounts = action.amounts || []
      const providedCaw = amounts.length > 0 ? Number(amounts[0]) : 0

      console.log(`[Validator] Image upload validation:`)
      console.log(`  - Image count: ${imageMatches.length}`)
      console.log(`  - Total data size: ${imageMatches.reduce((sum: number, m: string) => sum + m.replace('image64:', '').length, 0)} chars`)
      console.log(`  - Replication chains: ${replicationChainCount}`)
      console.log(`  - Provided CAW: ${providedCaw}`)
      console.log(`  - Required CAW: ${totalRequiredCaw}`)

      if (providedCaw < totalRequiredCaw) {
        console.log(`[Validator] ❌ Insufficient CAW for image storage: provided ${providedCaw}, required ${totalRequiredCaw}`)
        return { valid: false, requiredCaw: totalRequiredCaw, underpriced: true }
      }

      console.log(`[Validator] ✅ Image upload CAW check passed`)
      return { valid: true }
    }


    /** natstat: core polling loop */
    async function pollLoop() {
      try {
        const entries = await fetchPendingQueue()
        if (!entries.length) return

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
          const tipValidation = await validateActionTip(action, l2RpcUrl)
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
                // Check if all were processed by another validator
                const allByOther = simResult?.rejectionMessages?.every((msg: string) =>
                  msg?.includes('Cawonce already used')
                )
                if (allByOther) {
                  console.log(`[Validator] Client ${clientId}: all actions already processed by another validator`)
                  await Promise.all(subBatchEntries.map(entry =>
                    prisma.txQueue.update({ where: { id: entry.id }, data: { status: 'done' } })
                  ))
                  continue
                }

                console.log(`[Validator] Client ${clientId} simulation failed or no successful actions`)
                await Promise.all(subBatchEntries.map((entry, idx) => {
                  const rejection = simResult?.rejectionMessages?.[idx] || ''
                  const processedByOther = rejection.includes('Cawonce already used')
                  return prisma.txQueue.update({
                    where: { id: entry.id },
                    data: {
                      status: processedByOther ? 'done' : 'failed',
                      reason: processedByOther ? null : (rejection || 'Simulation failed')
                    }
                  })
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

              const finalized = await submitProcessActions(validatorId, succeededData, subQuote, gasLimit)
              console.log(`[Validator] Client ${clientId}: ${finalized.length} actions finalized`)

              const finalizedKeys = new Set(finalized.map((f: any) => `${f.senderId}-${f.cawonce}`))
              await Promise.all(subBatchEntries.map(async (entry, idx) => {
                const data = (entry.payload as any).data
                const key = `${data.senderId}-${data.cawonce}`
                const succeeded = finalizedKeys.has(key)
                await prisma.txQueue.update({
                  where: { id: entry.id },
                  data: {
                    status: succeeded ? 'done' : 'failed',
                    reason: succeeded ? null : (simResult.rejectionMessages?.[idx] || 'Transaction failed')
                  }
                })
              }))
            } catch (err: any) {
              console.error(`[Validator] Client ${clientId} batch failed:`, err.message)
              await Promise.all(subBatchEntries.map(entry => {
                return prisma.txQueue.update({
                  where: { id: entry.id },
                  data: { status: 'failed', reason: err.message }
                })
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
        // Mark ALL entries as failed, not just pass empty arrays
        await Promise.all(validatedEntries.map(entry => {
          return prisma.txQueue.update({
            where: { id: entry.id },
            data: {
              status: 'failed',
              reason: 'Simulation failed - internal error'
            }
          })
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
        // Check if all rejections are "Cawonce already used" — another validator processed them
        const allProcessedByOther = rejectionMessages.every((msg: string) =>
          msg?.includes('Cawonce already used')
        )
        if (allProcessedByOther) {
          console.log("[Validator] All actions already processed by another validator — marking as done")
          await Promise.all(validatedEntries.map(entry =>
            prisma.txQueue.update({
              where: { id: entry.id },
              data: { status: 'done' }
            })
          ))
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

            // Mark Caw as FAILED if this is a caw action
            if (data.actionType === 0 || data.actionType === 'caw') {
              try {
                console.log(`[Validator] Marking Caw as FAILED for user ${data.senderId} cawonce ${data.cawonce}: ${rejectionMessages[index] || 'Simulation rejected'}`)
                await prisma.caw.updateMany({
                  where: {
                    userId: data.senderId,
                    cawonce: data.cawonce,
                    status: 'PENDING'
                  },
                  data: {
                    status: 'FAILED',
                    reason: rejectionMessages[index] || 'Simulation rejected'
                  }
                })
              } catch (cawErr) {
                console.error('[Validator] Failed to mark caw as FAILED:', cawErr)
              }
            }

            // Mark Follow as FAILED if this is a follow action
            if (data.actionType === 4 || data.actionType === 'follow' || data.actionType === 5 || data.actionType === 'unfollow') {
              try {
                console.log(`[Validator] Marking Follow as FAILED:`)
                console.log(`  - Follower ID: ${data.senderId}`)
                console.log(`  - Following ID: ${data.receiverId}`)
                console.log(`  - Reason: ${rejectionMessages[index] || 'Simulation rejected - unknown reason'}`)

                const result = await prisma.follow.updateMany({
                  where: {
                    followerId: data.senderId,
                    followingId: data.receiverId,
                    status: 'PENDING'
                  },
                  data: {
                    status: 'FAILED'
                  }
                })

                console.log(`  - Updated ${result.count} Follow record(s)`)

                if (result.count === 0) {
                  console.log(`[Validator] WARNING: No PENDING follow record found to mark as FAILED for ${data.senderId} -> ${data.receiverId}`)
                }
              } catch (followErr) {
                console.error('[Validator] Failed to mark follow as FAILED:', followErr)
              }
            }

            return prisma.txQueue.update({
              where: { id: entry.id },
              data: {
                status: 'failed',
                reason: rejectionMessages[index] || 'Simulation rejected - unknown reason'
              }
            })
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
        finalized = await submitProcessActions(
           validatorId, multiSucceeded, succeededQuote, rawGasLimit
         )
        console.log("[Validator] ========== TRANSACTION SUBMISSION SUCCESSFUL ==========")
        console.log(`[Validator] ${finalized.length} actions finalized on chain`)
        finalized.forEach((f: any) => {
          console.log(`  - Sender ${f.senderId} cawonce ${f.cawonce}: ${getActionType(f.actionType)}`)
        })
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

        // Only set reason if status is failed
        const updateData: any = {
          status: succeeded ? 'done' : 'failed'
        }

        // Only add reason field if transaction failed AND we have a reason
        if (!succeeded && reason) {
          updateData.reason = reason
        } else if (succeeded && reason === null) {
          // Clear any existing reason for successful transactions
          updateData.reason = null
        }

        console.log(`[Validator] TxQueue #${entry.id} (${getActionType(data.actionType)} from ${data.senderId}): ${succeeded ? 'SUCCESS' : 'FAILED'} ${reason ? `- ${reason}` : ''}`)

        return prisma.txQueue.update({
          where: { id: entry.id },
          data: updateData
        })
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

        // Check if this is an OTHER action (actionType: 7) - could be on-chain image
        if (data.actionType === 7 || getActionType(data.actionType).toString() === 'OTHER') {
          const text = data.text || ''
          // Check if this is an on-chain image upload (has image64: content)
          if (text.includes('image64:')) {
            const imageRef = `img:${data.senderId}:${data.cawonce}`

            // Extract base64 data from text for creating record if it doesn't exist
            const imageMatch = text.match(/image64:([^\n]+)/)
            const base64Data = imageMatch ? imageMatch[1] : ''
            // Calculate cawCost from the data size (same formula as frontend)
            const cawCost = base64Data ? Math.ceil(base64Data.length / 1000) : 0

            if (succeeded) {
              // Upsert on-chain image as SUCCESS (creates if doesn't exist)
              try {
                await prisma.onChainImage.upsert({
                  where: { imageRef },
                  update: { status: 'SUCCESS' },
                  create: {
                    userId: data.senderId,
                    imageRef,
                    cawonce: data.cawonce,
                    base64Data,
                    cawCost,
                    status: 'SUCCESS'
                  }
                })
                console.log(`[ValidatorService] Upserted OnChainImage as SUCCESS: ${imageRef}`)
              } catch (imageUpdateErr: any) {
                console.error('[ValidatorService] Failed to upsert OnChainImage status to SUCCESS:', imageUpdateErr)
              }
            } else {
              // Upsert on-chain image as FAILED
              try {
                await prisma.onChainImage.upsert({
                  where: { imageRef },
                  update: {
                    status: 'FAILED',
                    reason: reason || 'Transaction failed'
                  },
                  create: {
                    userId: data.senderId,
                    imageRef,
                    cawonce: data.cawonce,
                    base64Data,
                    cawCost,
                    status: 'FAILED',
                    reason: reason || 'Transaction failed'
                  }
                })
                console.log(`[ValidatorService] Upserted OnChainImage as FAILED: ${imageRef} - ${reason}`)
              } catch (imageUpdateErr: any) {
                console.error('[ValidatorService] Failed to upsert OnChainImage status to FAILED:', imageUpdateErr)
              }
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

    // start polling
    console.log(`[Validator] Starting validator service with:`);
    console.log(`  - L2 RPC URL: ${l2RpcUrl}`);
    console.log(`  - ETH Mainnet RPC URL: ${ethMainnetRpcUrl}`);
    console.log(`  - Validator ID: ${validatorId}`);
    console.log(`  - Check Interval: ${checkInterval}ms`);
    console.log(`  - Wallet Address: ${wallet.address}`);

    timer = setInterval(() => pollLoop().catch(console.error), checkInterval)
    pollLoop().catch(console.error)

    return {
      started: Promise.resolve(),
      async stop() {
        clearInterval(timer)
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


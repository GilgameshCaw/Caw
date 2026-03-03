// src/services/ValidatorService/index.ts

import { z } from 'zod'
import 'dotenv/config'
import { Service } from '../../Service'
import { prisma }  from '../../prismaClient'
import getActionType from '../../abi/getActionType'
import { cawActionsAbi } from '../../abi/generated'
import { CAW_ACTIONS_ADDRESS, CAW_ADDRESS, WETH_ADDRESS } from '../../abi/addresses'
import { WebSocketProvider, JsonRpcProvider, Contract, Wallet } from 'ethers'

// Uniswap V2 Router ABI (minimal for getAmountsOut)
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

/**
 * Convert CAW amount to ETH using Uniswap V2 getAmountsOut
 * @param cawAmount - Amount of CAW tokens (in wei, i.e., with 18 decimals)
 * @param mainnetRpcUrl - Mainnet RPC URL for Uniswap query
 * @returns Amount of ETH (in wei) that the CAW would swap to
 */
async function cawToEth(cawAmount: bigint, mainnetRpcUrl: string): Promise<bigint> {
  if (cawAmount === BigInt(0)) {
    return BigInt(0)
  }

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

    let timer: NodeJS.Timeout

    /** natstat: load all pending queue entries */
    async function fetchPendingQueue() {
      // First, reset any 'processing' entries older than 2 minutes (likely stale from crash)
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000)
      const resetCount = await prisma.txQueue.updateMany({
        where: {
          status: 'processing',
          updatedAt: { lt: twoMinutesAgo }
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

        var withdraws = multiData.actions.filter(function(action: any) {return getActionType(action.actionType).toString() == 'WITHDRAW'});
        var quote = { nativeFee: BigInt(0) }; // Default quote for non-withdrawal actions
        if (withdraws.length > 0) {
          var tokenIds = withdraws.map(function(action){return action.senderId});
          console.log("get tokenIds:", tokenIds)
          var amounts = withdraws.map(function(action){return action.amounts[0]});
          console.log("meow amounts", amounts)
          try {
            quote = await cawActions.withdrawQuote(tokenIds, amounts, false) as any;
          } catch (err) {
            console.error("[Validator] Failed to get withdraw quote:", err);
            // Continue with default quote instead of failing
          }
          console.log('withdraw quote returned:', quote);
        }

        // ABI‐encode
        console.log("Before native process", quote)
        const calldata = iface.encodeFunctionData('safeProcessActions', [
          validatorId,
          { actions: multiData.actions, v: multiData.v, r: multiData.r, s: multiData.s },
          0
        ])
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

        const startTime = Date.now();

        // Add timeout wrapper to prevent hanging
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
          returnData = await Promise.race([callPromise, timeoutPromise]) as string
        } catch (timeoutErr: any) {
          console.error('[Validator] RPC call timeout or error:', timeoutErr.message)

          // If timeout, reinitialize the WebSocket connection
          if (timeoutErr.message?.includes('timeout')) {
            console.log('[Validator] Timeout detected - reinitializing WebSocket connection')
            initializeConnection()
          }

          throw timeoutErr
        }

        const elapsed = Date.now() - startTime;

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
      messagingFee: bigint
    ) {
      const calldata = iface.encodeFunctionData('processActions', [
        validatorId,
        { actions: multiData.actions, v: multiData.v, r: multiData.r, s: multiData.s },
        0
      ])

      const gasLimitRaw = await provider.estimateGas({
        to:    CAW_ACTIONS_ADDRESS,
        data:  calldata,
        value: messagingFee
      })

      const feeData = await provider.getFeeData()
      const gasPrice = feeData.gasPrice ?? BigInt(0)

      return gasLimitRaw * gasPrice;
    }


    /** natstat: estimate the raw gas‐limit for processActions */
    async function estimateGasLimit(
      validatorId: number,
      multiData: { actions: any[]; v: number[]; r: string[]; s: string[] },
      messagingFee: bigint
    ): Promise<bigint> {
      // 1) ABI-encode the same calldata you’d send on-chain
      const calldata = iface.encodeFunctionData('processActions', [
        validatorId,
        { actions: multiData.actions, v: multiData.v, r: multiData.r, s: multiData.s },
        0,
      ]);

      // 2) Ask the provider directly for the gas estimate
      const estimate = await provider.estimateGas({
        to:             CAW_ACTIONS_ADDRESS,
        data:           calldata,
        value:          messagingFee,
      });

      return estimate;
    }


    async function submitProcessActions(
      validatorId: number,
      multiData: { actions: any[]; v: number[]; r: string[]; s: string[] },
      messagingFee: bigint,
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
        messagingFee: messagingFee.toString(),
        gasLimit: rawGasLimit.toString()
      })

      try {
        // sendTransaction
        const tx = await wallet.sendTransaction({
          to:    CAW_ACTIONS_ADDRESS,
          data:  iface.encodeFunctionData('processActions', [
            validatorId,
            { actions: multiData.actions, v: multiData.v, r: multiData.r, s: multiData.s },
            0
          ]),
          value: messagingFee,
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
            return submitProcessActions(validatorId, multiData, messagingFee, rawGasLimit, retryCount + 1)
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
          return submitProcessActions(validatorId, multiData, messagingFee, rawGasLimit, retryCount + 1)
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
        const newStatus = succeededKeys.has(key)
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
                status: 'FAILED'
              }
            })
            console.log(`Marked caw as FAILED for user ${data.senderId} cawonce ${data.cawonce}`)
          } catch (cawUpdateErr) {
            console.error('Failed to update caw status to FAILED:', cawUpdateErr)
            // Continue even if caw update fails (might not exist)
          }
        } else if (newStatus === 'done' && (data.actionType === 0 || data.actionType === 'caw')) {
          // If succeeded, mark as SUCCESS
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

    /** natstat: check if OTHER actions have sufficient CAW payment for their content */
    function validateOtherActionCost(
      action: any
    ): { valid: boolean; requiredCaw?: number; underpriced?: boolean } {
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

      // Calculate required CAW for all images
      let totalRequiredCaw = 0
      for (const match of imageMatches) {
        const base64Data = match.replace('image64:', '')
        // Base64 encoding increases size by ~33%
        const originalSize = Math.ceil((base64Data.length * 3) / 4)
        // Using same calculation as frontend
        const MIN_CAW_COST = 500
        const l1GasPerByte = 16
        const l1DataGas = originalSize * l1GasPerByte
        const l2ExecutionGas = originalSize * 3
        const totalGas = l1DataGas + l2ExecutionGas
        const effectiveGasPrice = 8
        const cawPerGwei = 0.03
        const baseCost = Math.ceil(totalGas * effectiveGasPrice * cawPerGwei)
        const totalCost = Math.ceil(baseCost * 2.5) // Match frontend 2.5x markup
        totalRequiredCaw += Math.max(MIN_CAW_COST, totalCost)
      }

      // Check if amounts array has sufficient CAW
      const amounts = action.amounts || []
      const providedCaw = amounts.length > 0 ? Number(amounts[0]) : 0

      console.log(`[Validator] Image upload validation:`)
      console.log(`  - Image count: ${imageMatches.length}`)
      console.log(`  - Total data size: ${imageMatches.reduce((sum, m) => sum + m.replace('image64:', '').length, 0)} chars`)
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

        // Pre-filter entries that don't have sufficient CAW for OTHER actions
        const validatedEntries: typeof entries = []
        const underpricedEntries: typeof entries = []

        for (const entry of entries) {
          const action = (entry.payload as any).data
          const validation = validateOtherActionCost(action)
          if (validation.valid) {
            validatedEntries.push(entry)
          } else if (validation.underpriced) {
            underpricedEntries.push(entry)
            console.log(`[Validator] Marking txQueue entry ${entry.id} as underpriced: required ${validation.requiredCaw} CAW`)
          }
        }

        // Mark underpriced entries with 'underpriced' status for potential relay to other validators
        if (underpricedEntries.length > 0) {
          await Promise.all(underpricedEntries.map(entry => {
            const action = (entry.payload as any).data
            const validation = validateOtherActionCost(action)
            const reason = `Insufficient CAW: required ${validation.requiredCaw} CAW`

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



      // 2) estimate gas cost
      console.log("[Validator] Estimating gas cost...")
      const gasCost = await estimateProcessGasCost(
        validatorId, multiSucceeded, quote.nativeFee
      )
      console.log("[Validator] Estimated gas cost:", gasCost.toString(), "wei")

      console.log("[Validator] Estimating gas limit...")
      const rawGasLimit = await estimateGasLimit(
        validatorId, multiSucceeded, quote.nativeFee
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
           validatorId, multiSucceeded, quote.nativeFee, rawGasLimit
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
            // Mark caw as SUCCESS
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
                    status: 'FAILED'
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


// src/services/ValidatorService/index.ts

import { z } from 'zod'
import 'dotenv/config'
import { Service } from '../../Service'
import { prisma }  from '../../prismaClient'
import getActionType from '../../abi/getActionType'
import { cawActionsAbi } from '../../abi/generated'
import { CAW_ACTIONS_ADDRESS } from '../../abi/addresses'
import { WebSocketProvider, Contract, Wallet } from 'ethers'

/** natstat: validator configuration schema */
const ValidatorConfig = z.object({
  l2RpcUrl:      z.string(),
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
    const { l2RpcUrl, validatorId, checkInterval } = ValidatorConfig.parse(rawCfg)

    const privateKey = process.env.VALIDATOR_PRIVATE_KEY
    if (!privateKey) throw new Error('Missing VALIDATOR_PRIVATE_KEY in env')

    const provider    = new WebSocketProvider(l2RpcUrl)
    const wallet      = new Wallet(privateKey, provider)
    const cawActions  = new Contract(CAW_ACTIONS_ADDRESS, cawActionsAbi, wallet)
    const iface      = cawActions.interface  // shorthand


    let timer: NodeJS.Timeout

    /** natstat: load all pending queue entries */
    async function fetchPendingQueue() {
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
          setTimeout(() => reject(new Error('RPC call timeout after 300 seconds')), 300000)
        })

        let returnData: string
        try {
          returnData = await Promise.race([callPromise, timeoutPromise]) as string
        } catch (timeoutErr: any) {
          console.error('[Validator] RPC call timeout or error:', timeoutErr.message)
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
      rawGasLimit: bigint
    ) {
      console.log("will submit ", multiData.actions.length, multiData)
      console.log("[submitProcessActions] Getting fee data...")
      const feeData = await provider.getFeeData();
      console.log("[submitProcessActions] Fee data:", {
        maxFeePerGas: feeData.maxFeePerGas?.toString(),
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString()
      })

      console.log("[submitProcessActions] Sending transaction with params:", {
        to: CAW_ACTIONS_ADDRESS,
        validatorId,
        actionsCount: multiData.actions.length,
        messagingFee: messagingFee.toString(),
        gasLimit: rawGasLimit.toString()
      })

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
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
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
        const totalCost = Math.ceil(baseCost * 1.5)
        totalRequiredCaw += Math.max(MIN_CAW_COST, totalCost)
      }

      // Check if amounts array has sufficient CAW
      const amounts = action.amounts || []
      const providedCaw = amounts.length > 0 ? Number(amounts[0]) : 0

      if (providedCaw < totalRequiredCaw) {
        console.log(`Insufficient CAW for image storage: provided ${providedCaw}, required ${totalRequiredCaw}`)
        return { valid: false, requiredCaw: totalRequiredCaw, underpriced: true }
      }

      return { valid: true }
    }


    /** natstat: core polling loop */
    async function pollLoop() {
      try {
        const entries = await fetchPendingQueue()
        if (!entries.length) return

        console.log(`[Validator] Processing ${entries.length} pending transactions`)
        console.log(`[Validator] Queue IDs: ${entries.map(e => e.id).join(', ')}`)

        // Log transaction details for debugging
        entries.forEach(entry => {
          const action = (entry.payload as any).data
          console.log(`[Validator] TxQueue #${entry.id}: Type=${getActionType(action.actionType)}, Sender=${action.senderId}, Cawonce=${action.cawonce}`)
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
        const hasTemporaryError = rejectionMessages.some((msg: string) =>
          msg?.includes('timeout') ||
          msg?.includes('network') ||
          msg?.includes('connection') ||
          msg?.includes('RPC')
        )

        if (hasTemporaryError) {
          console.log("Detected temporary RPC/network error, resetting to pending for retry")
          await Promise.all(validatedEntries.map((entry, index) => {
            return prisma.txQueue.update({
              where: { id: entry.id },
              data: {
                status: 'pending', // Reset to pending for retry
                reason: null // Clear any previous reason
              }
            })
          }))
        } else {
          console.log("Detected permanent failure, marking as failed")
          // Mark ALL entries as failed with their specific rejection messages
          await Promise.all(validatedEntries.map((entry, index) => {
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

      // TODO : live fetch this price:
      // TODO : live fetch this price:
      // TODO : live fetch this price:
      // TODO : live fetch this price:
      const ethPerCaw = 16140000n;

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
      const totalTip = computeTotalTip(succeededEntries)
      const tipInWei = ethPerCaw * totalTip
      console.log(`[Validator] Tip calculation:`)
      console.log(`  - Total tip: ${totalTip} CAW`)
      console.log(`  - ETH per CAW: ${ethPerCaw}`)
      console.log(`  - Tip in wei: ${tipInWei} (${tipInWei.toString()})`)
      console.log(`  - Gas cost: ${gasCost} (${gasCost.toString()})`)
      console.log(`  - Tip >= Gas cost? ${tipInWei >= gasCost}`)

      if (totalTip * ethPerCaw < gasCost) {
        console.log("[Validator] ❌ SKIPPING - Tip is less than gas cost!")
        console.log(`[Validator] Need at least ${gasCost / ethPerCaw} CAW tip, but only have ${totalTip} CAW`)
        // Mark all entries as failed due to insufficient tip
        await updateQueueStatuses(entries, [],
          entries.map(() => 'Insufficient tip to cover gas costs'))
        return
      }
      console.log("[Validator] ✅ Tip check passed - proceeding with submission")

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
        finalized = await submitProcessActions(
           validatorId, multiSucceeded, quote.nativeFee, rawGasLimit
         )
        console.log("[Validator] Transaction submission result:", finalized ? "SUCCESS" : "FAILED")
      } catch (submitErr: any) {
        console.error("[Validator] Transaction submission failed - Full error object:", submitErr)
        console.error("[Validator] Error message:", submitErr.message)
        console.error("[Validator] Error stack:", submitErr.stack)
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
      await Promise.all(validatedEntries.map(async (entry, index) => {
        const { succeeded, reason } = finalStatuses[index]

        // Before marking as failed, reload from database to check if another process marked it as done
        if (!succeeded) {
          const currentEntry = await prisma.txQueue.findUnique({
            where: { id: entry.id },
            select: { status: true }
          })

          // If it's already done, skip marking as failed
          if (currentEntry?.status === 'done') {
            console.log(`[Validator] TxQueue entry ${entry.id} already marked as 'done', skipping failed update`)
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

        return prisma.txQueue.update({
          where: { id: entry.id },
          data: updateData
        })
      }))

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
    console.log(`  - RPC URL: ${l2RpcUrl}`);
    console.log(`  - Validator ID: ${validatorId}`);
    console.log(`  - Check Interval: ${checkInterval}ms`);
    console.log(`  - Wallet Address: ${wallet.address}`);

    timer = setInterval(() => pollLoop().catch(console.error), checkInterval)
    pollLoop().catch(console.error)

    return {
      started: Promise.resolve(),
      async stop() {
        clearInterval(timer)
      },
      stats: async () => {
        const count = await prisma.txQueue.count({ where: { status: 'pending' } })
        return `pending=${count}`
      }
    }
  }
}


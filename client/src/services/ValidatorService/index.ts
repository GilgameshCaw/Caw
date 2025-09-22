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
      multiData: { actions: any[]; v: number[]; r: string[]; s: string[] }
    ) {
      try {
        console.log("will simulate actions:", multiData.actions)
        var withdraws = multiData.actions.filter(function(action: any) {return getActionType(action.actionType).toString() == 'WITHDRAW'});
        var quote = { nativeFee: BigInt(0) }; // Default quote for non-withdrawal actions
        var withdrawTypes = multiData.actions.map(function(action: any) {return getActionType(action.actionType).toString()});
        console.log("Withdraws:", withdraws, withdrawTypes)
        if (withdraws.length > 0) {
          var tokenIds = withdraws.map(function(action){return action.senderId});
          console.log("get tokenIds:", tokenIds)
          var amounts = withdraws.map(function(action){return action.amounts[0]});
          console.log("amounts", amounts)
          quote = await cawActions.withdrawQuote(tokenIds, amounts, false);
          console.log('withdraw quote returned:', quote);
        }


        // ABI‐encode
        console.log("Before native process", quote)
        const calldata = iface.encodeFunctionData('safeProcessActions', [
          validatorId,
          { actions: multiData.actions, v: multiData.v, r: multiData.r, s: multiData.s },
          0
        ])
        console.log("got call data", calldata, quote?.nativeFee)

        const returnData = await provider.call({ to: CAW_ACTIONS_ADDRESS, data: calldata, value: quote?.nativeFee })
        console.log("Called!")
        const decoded = iface.decodeFunctionResult(
          'safeProcessActions',
          returnData
        ) as [ any[], string[] ]  // [ successfulActions, rejectionMessages ]
        console.log("decoded", decoded)

        const [ successfulActions, rejectionMessages ] = decoded

        console.log("simulated:", successfulActions.length, rejectionMessages)
        return { successfulActions, rejectionMessages, quote }
      } catch (err: any) {
        console.error("FAILED to simulate actions:", err.message || err)
        // Return empty successful actions and error messages for all actions
        const rejectionMessages = multiData.actions.map(() => {
          if (err.message?.includes('execution reverted')) {
            return 'Transaction simulation failed - execution reverted'
          } else if (err.message?.includes('insufficient funds')) {
            return 'Insufficient funds for transaction'
          } else if (err.message?.includes('nonce')) {
            return 'Invalid nonce - transaction may be outdated'
          } else {
            return `Simulation error: ${err.message || 'Unknown error'}`
          }
        })
        return { successfulActions: [], rejectionMessages, quote: { nativeFee: BigInt(0) } }
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
      const feeData = await provider.getFeeData();

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
      const receipt = await tx.wait()

      const evt = receipt?.logs
        ?.map(log => { try { return iface.parseLog(log) } catch { return null } })
        ?.find(x => x?.name === 'ActionsProcessed')

      if (!evt) throw new Error('ActionsProcessed event missing')

      const processed = (evt.args.actions as any[]).map(a => ({
        senderId:     Number(a.senderId),
        cawonce:      Number(a.cawonce)
      }))
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

      await Promise.all(queueEntries.map((entry, index) => {
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

        return prisma.txQueue.update({
          where: { id: entry.id },
          data:  {
            status: newStatus,
            ...(reason ? { reason } : {})
          }
        })
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
      const entries = await fetchPendingQueue()
      if (!entries.length) return

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
          console.log(`Marking txQueue entry ${entry.id} as underpriced: required ${validation.requiredCaw} CAW`)
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
      if (!validatedEntries.length) return

      const fullBatch = buildMultiActionData(validatedEntries)
      const totalTipBefore = computeTotalTip(validatedEntries)

        console.log("will Simulate", validatorId);
      // 1) simulate
      const simulationResult = await simulateActions(validatorId, fullBatch)

      // Check if simulateActions returned undefined (error case)
      if (!simulationResult) {
        console.error("Simulation returned undefined, marking all as failed")
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

      const { successfulActions, rejectionMessages, quote } = simulationResult
      console.log(successfulActions, '////////////////', validatedEntries);

        console.log("Simulation complete:", successfulActions.length, rejectionMessages)

      if (!successfulActions || !successfulActions.length) {
        console.log("No successful actions from simulation, marking all as failed")
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
      const succeededEntries = validatedEntries.filter((e, index) => {
        return rejectionMessages[index] == '';
        // const d = (e.payload as any).data
        // return succeededKeys.has(`${d.senderId}-${d.cawonce}`)
      })

      // rebuild your call data only with the succeeded entries
      const multiSucceeded = buildMultiActionData(succeededEntries)
      console.log("LENGH", multiSucceeded.actions.length)
      console.log("ready to roll:", multiSucceeded.actions.length)



      // 2) estimate gas cost
      const gasCost = await estimateProcessGasCost(
        validatorId, multiSucceeded, quote.nativeFee
      )

      const rawGasLimit = await estimateGasLimit(
        validatorId, multiSucceeded, quote.nativeFee
      );

      // recompute tip from only the successful ones
      const totalTip = computeTotalTip(succeededEntries)
      console.log(`tip ${totalTip} (≈ ${ethPerCaw * totalTip} wei) vs gasCost ${gasCost}`)
      if (totalTip * ethPerCaw < gasCost) {
        console.log("Skipping because tip < gasCost")
        // Mark all entries as failed due to insufficient tip
        await updateQueueStatuses(entries, [],
          entries.map(() => 'Insufficient tip to cover gas costs'))
        return
      }

      const finalized = await submitProcessActions(
         validatorId, multiSucceeded, quote.nativeFee, rawGasLimit
       )

      // 4) update database - properly track which entries succeeded vs failed
      // Build array to track success/failure for each original entry
      const finalStatuses = validatedEntries.map((entry, index) => {
        // Check if this entry was in the succeeded set that got submitted
        const wasSubmitted = succeededEntries.includes(entry)
        if (!wasSubmitted) {
          // This entry failed simulation, return empty success
          return { succeeded: false, reason: rejectionMessages[index] }
        }
        // This entry was submitted, check if it finalized
        const data = (entry.payload as any).data
        const isFinalized = finalized.some(
          f => f.senderId === data.senderId && f.cawonce === data.cawonce
        )
        return {
          succeeded: isFinalized,
          reason: isFinalized ? undefined : 'Transaction failed on chain'
        }
      })

      // Update each entry with its actual status
      await Promise.all(validatedEntries.map((entry, index) => {
        const { succeeded, reason } = finalStatuses[index]
        return prisma.txQueue.update({
          where: { id: entry.id },
          data: {
            status: succeeded ? 'done' : 'failed',
            ...(reason ? { reason } : {})
          }
        })
      }))
    }

    // start polling
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


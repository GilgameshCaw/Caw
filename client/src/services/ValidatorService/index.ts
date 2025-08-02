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

        actions.push((entry.payload as any).data)
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
        var quote;
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
        return { successfulActions, rejectionMessages }
      } catch (err) {
        console.error("FAILED to simulate actions", err)
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

      await Promise.all(queueEntries.map(entry => {
        const data = (entry.payload as any).data
        const key  = `${data.senderId}-${data.cawonce}`
        const newStatus = succeededKeys.has(key)
          ? 'done'
          : 'failed'
        console.log("new status", newStatus)

        return prisma.txQueue.update({
          where: { id: entry.id },
          data:  { status: newStatus }
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


    /** natstat: core polling loop */
    async function pollLoop() {
      const entries = await fetchPendingQueue()
      if (!entries.length) return

      const fullBatch = buildMultiActionData(entries)
      const totalTipBefore = computeTotalTip(entries)

        console.log("will Simulat", validatorId);
      // 1) simulate
      const { successfulActions, rejectionMessages } =
        await simulateActions(validatorId, fullBatch)
      console.log(successfulActions, '////////////////', entries);

        console.log("Simulation complete:", successfulActions.length, rejectionMessages)

      if (!successfulActions.length) {
        await updateQueueStatuses(entries, [], rejectionMessages)
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
      const succeededEntries = entries.filter((e, index) => {
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
        validatorId, multiSucceeded, /* messagingFee= */ BigInt(0)
      )

      const rawGasLimit = await estimateGasLimit(
        validatorId, multiSucceeded, /* messagingFee=*/ 0n
      );

      // recompute tip from only the successful ones
      const totalTip = computeTotalTip(succeededEntries)
      console.log(`tip ${totalTip} (≈ ${ethPerCaw * totalTip} wei) vs gasCost ${gasCost}`)
      if (totalTip * ethPerCaw < gasCost) {
        console.log("Skipping because tip < gasCost")
        return
      }

      const finalized = await submitProcessActions(
         validatorId, multiSucceeded, /* messagingFee= */ BigInt(0), rawGasLimit
       )

      // 4) update database
      await updateQueueStatuses(entries, finalized, rejectionMessages)
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


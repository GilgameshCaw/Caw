import { ethers } from 'ethers'
import { packActions, getPackedActionSlices } from './packActions'

/**
 * Rebuild the ActionBatch message that a batch signature commits to, from the
 * per-action `data` of every row in the group, in submission order.
 *
 * /api/actions/batch stores ONE action's data per TxQueue row
 * (payload.data), but the row's signedTx is the single ActionBatch signature
 * over the whole group. Anything that needs to recover the signer of such a
 * row has to rebuild this message first; verifying payload.data against the
 * ActionBatch type throws, because it has none of the ActionBatch fields.
 *
 * Same construction as /api/actions/batch and the FE's signAndSubmitMany:
 * keccak each packed per-action slice, keccak the concatenation, and sign
 * ActionBatch(senderId, firstCawonce, actionCount, actionsHash).
 */
export function buildActionBatchMessage(actionsData: any[]): {
  senderId: number
  firstCawonce: number
  actionCount: number
  actionsHash: string
} {
  if (actionsData.length === 0) throw new Error('Empty action batch')
  const sanitizedActions = actionsData.map((d: any) => {
    const amounts = Array.isArray(d.amounts) ? d.amounts.map((amt: any) => {
      if (amt === null || amt === undefined || amt === '') return '0'
      const strAmt = String(amt)
      return (strAmt === 'NaN' || isNaN(Number(strAmt))) ? '0' : strAmt
    }) : []
    return {
      actionType: Number(d.actionType),
      senderId: Number(d.senderId),
      receiverId: Number(d.receiverId || 0),
      receiverCawonce: Number(d.receiverCawonce || 0),
      networkId: Number(d.networkId),
      cawonce: Number(d.cawonce),
      recipients: (d.recipients || []).map(Number),
      amounts: amounts.map((x: any) => BigInt(x)),
      text: d.text || '0x',
    }
  })
  const slices = getPackedActionSlices(packActions(sanitizedActions))
  const perActionHashes: string[] = slices.map(s => ethers.keccak256(s))
  const actionsHash = ethers.keccak256(ethers.solidityPacked(
    Array(perActionHashes.length).fill('bytes32'),
    perActionHashes,
  ))
  return {
    senderId: Number(actionsData[0].senderId),
    firstCawonce: Number(actionsData[0].cawonce),
    actionCount: actionsData.length,
    actionsHash,
  }
}

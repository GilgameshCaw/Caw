// Which slots of a CawActions batch actually ran on chain.
//
// processActions / safeProcessActions emit ActionsProcessed. Every slot in
// their packedActions ran, except the ones safeProcessActions rejected
// (reported separately as ActionRejected).
//
// processActionsWithZkSigs emits ActionsProcessedZk instead, and skips
// (rather than reverts on) a slot whose cawonce is already used. Bit i of
// actionsExecutedBitmap is 0 for a skipped slot i, in packedActions order.
// A skipped slot changes no chain state (CawActions._zkApplyOne), so it
// must not be indexed, or taken as the action that used its cawonce.

import { Interface } from 'ethers'

export const ACTIONS_PROCESSED_ZK_IFACE = new Interface([
  'event ActionsProcessedZk(uint32 indexed networkId, uint32 indexed validatorId, uint16 actionCount, uint256 actionsExecutedBitmap, bytes32 batchHash)',
])

export const ACTIONS_PROCESSED_ZK_TOPIC = ACTIONS_PROCESSED_ZK_IFACE.getEvent('ActionsProcessedZk')!.topicHash

/**
 * The executed-slot bitmap carried by an ActionsProcessedZk log, or null for
 * any other log (every slot of that batch ran). Throws when a ZK log's data
 * does not decode: guessing would either index skipped slots or drop real ones.
 */
export function zkExecutedBitmap(log: { topics: ReadonlyArray<string>; data: string }): bigint | null {
  if (log.topics[0]?.toLowerCase() !== ACTIONS_PROCESSED_ZK_TOPIC) return null
  const parsed = ACTIONS_PROCESSED_ZK_IFACE.parseLog({ topics: [...log.topics], data: log.data })
  if (!parsed) throw new Error('ActionsProcessedZk log did not decode')
  return BigInt(parsed.args.actionsExecutedBitmap)
}

/** Whether slot `i` ran, given the bitmap from zkExecutedBitmap (null = all ran). */
export function slotExecuted(bitmap: bigint | null, i: number): boolean {
  return bitmap === null || (bitmap & (1n << BigInt(i))) !== 0n
}

/**
 * How many of a batch's `actionCount` slots ran, which is how far the batch
 * moved networkActionCount and the hash chain (null bitmap = all of them).
 */
export function executedSlotCount(bitmap: bigint | null, actionCount: number): number {
  let n = 0
  for (let i = 0; i < actionCount; i++) if (slotExecuted(bitmap, i)) n++
  return n
}

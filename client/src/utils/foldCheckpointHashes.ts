import { keccak256, solidityPacked } from 'ethers'
import { bytesToHex, getPackedActionSlices } from './packActions'

/**
 * Given a submitter's packedActions + r[] and the on-chain entry hash (the
 * clientCurrentHash at checkpoint start-1), roll through the same hash-chain
 * the L2 contract computes:
 *
 *   actionHash       = keccak256(packedActionSlice)
 *   currentHash      = keccak256(abi.encodePacked(prevHash, r, actionHash))
 *   checkpointHash   = currentHash at every CHECKPOINT_INTERVAL boundary
 *
 * This lets an off-chain monitor reconstruct what the submitter's *claimed*
 * checkpoint hashes must be, independent of what the honest L2 actions
 * would produce. Comparing those to L2's clientHashAtCheckpoint is how
 * Mode B fraud (submitter invented actions and signed them into their own
 * consistent root) is detected.
 *
 * Returns null if the action count in `packed` doesn't match the expected
 * range length — that would itself be a malformed submission, not something
 * we try to salvage.
 */
export function foldCheckpointHashes(
  packed: Uint8Array,
  r: string[],
  entryHash: string,
  startCheckpointId: number,
  endCheckpointId: number,
  checkpointInterval: number = 32,
): string[] | null {
  const numCheckpoints = endCheckpointId - startCheckpointId + 1
  const expectedActions = numCheckpoints * checkpointInterval

  const actionSlices = getPackedActionSlices(packed)
  if (actionSlices.length !== expectedActions) return null
  if (r.length !== expectedActions) return null

  const hashes: string[] = []
  let h = entryHash
  for (let i = 0; i < expectedActions; i++) {
    const actionHash = keccak256(bytesToHex(actionSlices[i]))
    h = keccak256(solidityPacked(['bytes32', 'bytes32', 'bytes32'], [h, r[i], actionHash]))
    if ((i + 1) % checkpointInterval === 0) hashes.push(h)
  }
  return hashes
}

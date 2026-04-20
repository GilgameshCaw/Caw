/**
 * Merkle tree for checkpoint hashes, compatible with OpenZeppelin's MerkleProof.verify
 * using double-hash leaves:
 *
 *   bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(checkpointId, claimedHash))));
 *
 * Uses sorted pairs to match OZ's MerkleProof implementation.
 */

import { keccak256, AbiCoder } from 'ethers'

const coder = new AbiCoder()

/**
 * Compute the double-hashed leaf for a (checkpointId, hash) pair.
 * Matches the Solidity: keccak256(bytes.concat(keccak256(abi.encode(checkpointId, claimedHash))))
 */
function hashLeaf(checkpointId: number, checkpointHash: string): string {
  const innerHash = keccak256(coder.encode(['uint256', 'bytes32'], [checkpointId, checkpointHash]))
  return keccak256(innerHash)
}

/**
 * Combine two sibling hashes using sorted-pair ordering (matches OZ MerkleProof).
 */
function hashPair(a: string, b: string): string {
  // OZ sorts the pair: the smaller value goes first
  const [left, right] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]
  return keccak256(coder.encode(['bytes32', 'bytes32'], [left, right]))
}

/**
 * Build a Merkle tree over checkpoint (id, hash) pairs.
 *
 * @param checkpointIds  Array of checkpoint IDs (e.g. [5, 6, 7, 8])
 * @param checkpointHashes  Corresponding hash for each checkpoint
 * @returns Object with `root` and a `getProof(index)` function
 */
export function buildCheckpointMerkleTree(
  checkpointIds: number[],
  checkpointHashes: string[]
): { root: string; getProof(index: number): string[] } {
  if (checkpointIds.length !== checkpointHashes.length) {
    throw new Error(`Mismatched lengths: ${checkpointIds.length} ids vs ${checkpointHashes.length} hashes`)
  }
  if (checkpointIds.length === 0) {
    throw new Error('Cannot build merkle tree with zero leaves')
  }

  // Compute leaves
  const leaves = checkpointIds.map((id, i) => hashLeaf(id, checkpointHashes[i]))

  // Build tree layers bottom-up. layers[0] = leaves, layers[last] = [root]
  const layers: string[][] = [leaves.slice()]

  while (layers[layers.length - 1].length > 1) {
    const current = layers[layers.length - 1]
    const next: string[] = []
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        next.push(hashPair(current[i], current[i + 1]))
      } else {
        // Odd node — promote it to the next level
        next.push(current[i])
      }
    }
    layers.push(next)
  }

  const root = layers[layers.length - 1][0]

  function getProof(index: number): string[] {
    if (index < 0 || index >= leaves.length) {
      throw new Error(`Index ${index} out of range [0, ${leaves.length})`)
    }

    const proof: string[] = []
    let idx = index

    for (let layer = 0; layer < layers.length - 1; layer++) {
      const currentLayer = layers[layer]
      // Sibling index
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1
      if (siblingIdx < currentLayer.length) {
        proof.push(currentLayer[siblingIdx])
      }
      // Move to parent index
      idx = Math.floor(idx / 2)
    }

    return proof
  }

  return { root, getProof }
}

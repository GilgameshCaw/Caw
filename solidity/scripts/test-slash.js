#!/usr/bin/env node
/**
 * Slash Test Script
 *
 * Tests the full challenge/slash flow:
 * 1. Deposits stake on L2b archive
 * 2. Submits bad data (wrong merkle root) for an unclaimed checkpoint
 * 3. Calls CawChallengeRelay on L2 to relay the correct hash
 * 4. Waits for LZ delivery
 * 5. Calls resolveChallenge on L2b to slash
 * 6. Verifies stake was slashed and checkpoints released
 *
 * Usage: node scripts/test-slash.js
 */

require('dotenv').config()
const { ethers, keccak256, AbiCoder } = require('ethers')

const ARCHIVE_ADDRESS = '0x360602c0dd788C18240249d4d9ED0451f8bD1ee5'
const RELAY_ADDRESS = '0xb3fF59926e50596C1563BB703455050256E70951'
const CAW_ACTIONS_ADDRESS = '0x74dE2aCE81EC0be0b1DC7614679dc50254c4305f'

const ARCHIVE_ABI = [
  'function stakes(address) view returns (uint256)',
  'function pendingCount(address) view returns (uint256)',
  'function deposit() payable',
  'function submitReplication(uint32 networkId, uint256 startCheckpointId, uint256 endCheckpointId, bytes packedActions, bytes32[] r, bytes32 merkleRoot)',
  'function checkpointClaimed(uint32, uint256) view returns (uint256)',
  'function getSubmission(uint256) view returns (address, bytes32, uint32, uint256, uint256, uint256, uint8)',
  'function challengeDelivered(uint256, uint256) view returns (bool)',
  'function challengeHash(uint256, uint256) view returns (bytes32)',
  'function resolveChallenge(uint256 submissionId, uint256 checkpointId, bytes32 claimedHash, bytes32[] merkleProof)',
  'function nextSubmissionId() view returns (uint256)',
  'event SubmissionCreated(uint256 indexed submissionId, address indexed submitter, uint32 indexed networkId, uint256 startCheckpointId, uint256 endCheckpointId, bytes32 merkleRoot, uint256 stakeAmount)',
  'event ValidatorSlashed(address indexed validator, address indexed challenger, uint256 submissionId, uint256 checkpointId, uint256 reward)',
]

const RELAY_ABI = [
  'function relayChallenge(uint32 destEid, uint256 submissionId, uint32 networkId, uint256 checkpointId) payable',
  'function quoteChallenge(uint32 destEid, uint256 submissionId, uint32 networkId, uint256 checkpointId, bool payInLzToken) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))',
]

const CAW_ACTIONS_ABI = [
  'function networkHashAtCheckpoint(uint32, uint256) view returns (bytes32)',
  'function networkActionCount(uint32) view returns (uint256)',
]

// Merkle tree helper (must match OZ MerkleProof.verify)
const coder = new AbiCoder()
function hashLeaf(checkpointId, checkpointHash) {
  const inner = keccak256(coder.encode(['uint256', 'bytes32'], [checkpointId, checkpointHash]))
  return keccak256(inner)
}

function buildMerkleRoot(checkpointIds, hashes) {
  const leaves = checkpointIds.map((id, i) => hashLeaf(id, hashes[i]))
  // For a single leaf, the root IS the leaf
  if (leaves.length === 1) return { root: leaves[0], leaves, proof: [] }
  // For two leaves, sort and hash
  const [a, b] = leaves[0] < leaves[1] ? [leaves[0], leaves[1]] : [leaves[1], leaves[0]]
  const root = keccak256(coder.encode(['bytes32', 'bytes32'], [a, b]))
  return {
    root,
    leaves,
    getProof: (index) => [leaves[index === 0 ? 1 : 0]]
  }
}

async function main() {
  const pk = process.env.PRIVATE_KEYS?.split(',')[0]
  if (!pk) throw new Error('PRIVATE_KEYS not set')

  // Use a DIFFERENT wallet for the bad submission so the monitor treats it as foreign
  // Hardhat test account #2 (well-known test key)
  const badActorPk = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

  // Connect to both chains
  const l2Provider = new ethers.JsonRpcProvider(process.env.L2_RPC_URL, undefined, { batchMaxCount: 1 })
  const l2bProvider = new ethers.JsonRpcProvider(process.env.L2B_RPC_URL, undefined, { batchMaxCount: 1 })

  const l2Wallet = new ethers.Wallet(pk, l2Provider)
  const l2bWallet = new ethers.Wallet(pk, l2bProvider)

  const archive = new ethers.Contract(ARCHIVE_ADDRESS, ARCHIVE_ABI, l2bWallet)
  const relay = new ethers.Contract(RELAY_ADDRESS, RELAY_ABI, l2Wallet)
  const cawActions = new ethers.Contract(CAW_ACTIONS_ADDRESS, CAW_ACTIONS_ABI, l2Provider)

  console.log('Wallet:', l2Wallet.address)

  // Step 0: Check what checkpoints exist
  const actionCount = Number(await cawActions.networkActionCount(1))
  const totalCheckpoints = Math.floor(actionCount / 32)
  console.log(`Network 1: ${actionCount} actions, ${totalCheckpoints} checkpoints`)

  // Find an unclaimed checkpoint
  let targetCp = 0
  for (let cp = totalCheckpoints; cp >= 1; cp--) {
    const claimed = Number(await archive.checkpointClaimed(1, cp))
    if (claimed === 0) { targetCp = cp; break }
  }

  if (targetCp === 0) {
    console.log('No unclaimed checkpoints. Submit some posts first.')
    process.exit(1)
  }

  console.log(`\nTarget checkpoint: ${targetCp}`)
  const correctHash = await cawActions.networkHashAtCheckpoint(1, targetCp)
  console.log('Correct hash on L2:', correctHash)

  // Step 1: Ensure we have stake
  const stake = await archive.stakes(l2bWallet.address)
  console.log('Current stake:', ethers.formatEther(stake), 'ETH')
  if (stake < ethers.parseEther('0.01')) {
    console.log('Depositing stake...')
    const tx = await archive.deposit({ value: ethers.parseEther('0.02') })
    await tx.wait()
    console.log('Deposited 0.02 ETH')
  }

  // Step 2: Submit BAD data for this checkpoint
  // Build minimal packed actions for 32 actions (1 checkpoint)
  const buf = Buffer.alloc(2 + 32 * 25)
  buf.writeUInt16BE(32, 0)
  for (let i = 0; i < 32; i++) {
    const off = 2 + i * 25
    buf.writeUInt8(0, off)         // actionType
    buf.writeUInt32BE(1, off + 1)  // senderId
    buf.writeUInt32BE(0, off + 5)  // receiverId
    buf.writeUInt32BE(0, off + 9)  // receiverCawonce
    buf.writeUInt32BE(1, off + 13) // networkId
    buf.writeUInt32BE(i, off + 17) // cawonce (fake)
    buf.writeUInt8(0, off + 21)    // rc
    buf.writeUInt8(0, off + 22)    // ac
    buf.writeUInt16BE(0, off + 23) // textLength
  }
  const fakePackedHex = '0x' + buf.toString('hex')
  const fakeR = Array(32).fill(ethers.ZeroHash)

  // Build a WRONG merkle root — use a fake checkpoint hash
  const fakeCheckpointHash = keccak256(coder.encode(['string'], ['FAKE_DATA_FOR_SLASH_TEST']))
  const { root: fakeMerkleRoot, getProof } = buildMerkleRoot([targetCp], [fakeCheckpointHash])

  console.log('\nSubmitting BAD replication for checkpoint', targetCp)
  console.log('Fake merkle root:', fakeMerkleRoot)
  console.log('Fake checkpoint hash:', fakeCheckpointHash)

  const submitTx = await archive.submitReplication(
    1, targetCp, targetCp,
    fakePackedHex, fakeR, fakeMerkleRoot,
    { gasLimit: 500_000 }
  )
  const submitReceipt = await submitTx.wait()
  console.log('Submitted! tx:', submitReceipt.hash)

  // Get the submission ID
  const nextId = Number(await archive.nextSubmissionId())
  const submissionId = nextId - 1
  console.log('Submission ID:', submissionId)

  const sub = await archive.getSubmission(submissionId)
  console.log('Submission status:', ['PENDING', 'FINALIZED', 'SLASHED'][Number(sub[6])])

  // Step 3: Relay challenge from L2
  const L2B_EID = 40231 // Arbitrum Sepolia
  console.log('\nRelaying challenge from L2...')

  const quote = await relay.quoteChallenge(L2B_EID, submissionId, 1, targetCp, false)
  console.log('Challenge LZ fee:', ethers.formatEther(quote.nativeFee), 'ETH')

  const relayTx = await relay.relayChallenge(L2B_EID, submissionId, 1, targetCp, {
    value: quote.nativeFee * 120n / 100n, // 20% buffer
    gasLimit: 200_000,
  })
  const relayReceipt = await relayTx.wait()
  console.log('Challenge relayed! tx:', relayReceipt.hash)

  // Step 4: Wait for LZ delivery
  console.log('\nWaiting for LZ delivery (polling every 15s)...')
  for (let i = 0; i < 20; i++) {
    const delivered = await archive.challengeDelivered(submissionId, targetCp)
    if (delivered) {
      console.log('Challenge delivered!')
      const deliveredHash = await archive.challengeHash(submissionId, targetCp)
      console.log('Delivered correct hash:', deliveredHash)
      console.log('Matches L2?', deliveredHash === correctHash)
      break
    }
    console.log(`  Waiting... (${(i + 1) * 15}s)`)
    await new Promise(r => setTimeout(r, 15000))
  }

  const delivered = await archive.challengeDelivered(submissionId, targetCp)
  if (!delivered) {
    console.log('LZ delivery timed out (5 min). Try running resolveChallenge manually after delivery.')
    process.exit(1)
  }

  // Step 5: Resolve the challenge (slash!)
  console.log('\nResolving challenge (slashing)...')
  const proof = getProof(0)
  console.log('Merkle proof:', proof)
  console.log('Claimed hash (fake):', fakeCheckpointHash)

  const stakeBefore = await archive.stakes(l2bWallet.address)
  console.log('Stake before slash:', ethers.formatEther(stakeBefore), 'ETH')

  const resolveTx = await archive.resolveChallenge(
    submissionId, targetCp, fakeCheckpointHash, proof,
    { gasLimit: 500_000 }
  )
  const resolveReceipt = await resolveTx.wait()
  console.log('Slashed! tx:', resolveReceipt.hash)

  const stakeAfter = await archive.stakes(l2bWallet.address)
  console.log('Stake after slash:', ethers.formatEther(stakeAfter), 'ETH')
  console.log('Stake lost:', ethers.formatEther(stakeBefore - stakeAfter), 'ETH')

  // Step 6: Verify state
  const subAfter = await archive.getSubmission(submissionId)
  console.log('\nSubmission status:', ['PENDING', 'FINALIZED', 'SLASHED'][Number(subAfter[6])])

  const claimedAfter = Number(await archive.checkpointClaimed(1, targetCp))
  console.log('Checkpoint', targetCp, 'claimed by:', claimedAfter === 0 ? 'RELEASED (available for resubmission)' : `submission ${claimedAfter}`)

  console.log('\n=== SLASH TEST COMPLETE ===')
}

main().catch(console.error)

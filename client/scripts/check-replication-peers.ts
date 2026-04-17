// Verify LZ peer configuration for the replication path:
//   L2 replicator (Base Sepolia, eid 40245) →  L2b archive (Arbitrum Sepolia, eid 40231)
// Both sides must have the other registered as a peer, or _lzSend reverts.

import 'dotenv/config'
import { JsonRpcProvider, Contract, zeroPadValue } from 'ethers'
import {
  CAW_ACTIONS_REPLICATOR_L2_ADDRESS,
  CAW_ACTIONS_ARCHIVE_L2B_ADDRESS,
} from '../src/abi/addresses'

const PEER_ABI = ['function peers(uint32) view returns (bytes32)']
const BASE_SEPOLIA_EID = 40245
const ARB_SEPOLIA_EID = 40231

async function main() {
  const baseRpc = process.env.RPC_BASE_SEPOLIA || 'https://sepolia.base.org'
  const arbRpc = process.env.RPC_ARBITRUM_SEPOLIA || 'https://sepolia-rollup.arbitrum.io/rpc'

  const baseProvider = new JsonRpcProvider(baseRpc)
  const arbProvider = new JsonRpcProvider(arbRpc)

  console.log(`\n== Source side: L2 replicator on Base Sepolia ==`)
  console.log(`   Address: ${CAW_ACTIONS_REPLICATOR_L2_ADDRESS}`)
  const replicator = new Contract(CAW_ACTIONS_REPLICATOR_L2_ADDRESS, PEER_ABI, baseProvider)
  const peerFromReplicator = await replicator.peers(ARB_SEPOLIA_EID)
  const expectedArchivePeer = zeroPadValue(CAW_ACTIONS_ARCHIVE_L2B_ADDRESS.toLowerCase(), 32)
  console.log(`   peers(${ARB_SEPOLIA_EID}): ${peerFromReplicator}`)
  console.log(`   expected:                 ${expectedArchivePeer}`)
  const srcOk = peerFromReplicator.toLowerCase() === expectedArchivePeer.toLowerCase()
  console.log(`   match: ${srcOk ? '✓' : '✗'}`)

  console.log(`\n== Destination side: L2b archive on Arbitrum Sepolia ==`)
  console.log(`   Address: ${CAW_ACTIONS_ARCHIVE_L2B_ADDRESS}`)
  const archive = new Contract(CAW_ACTIONS_ARCHIVE_L2B_ADDRESS, PEER_ABI, arbProvider)
  const peerFromArchive = await archive.peers(BASE_SEPOLIA_EID)
  const expectedReplicatorPeer = zeroPadValue(CAW_ACTIONS_REPLICATOR_L2_ADDRESS.toLowerCase(), 32)
  console.log(`   peers(${BASE_SEPOLIA_EID}): ${peerFromArchive}`)
  console.log(`   expected:                 ${expectedReplicatorPeer}`)
  const dstOk = peerFromArchive.toLowerCase() === expectedReplicatorPeer.toLowerCase()
  console.log(`   match: ${dstOk ? '✓' : '✗'}`)

  console.log(`\n== Diagnosis ==`)
  if (!srcOk) {
    console.log(`✗ Replicator missing peer for Arbitrum Sepolia (eid ${ARB_SEPOLIA_EID}).`)
    console.log(`   Fix: addArchiveChain(${ARB_SEPOLIA_EID}, ${CAW_ACTIONS_ARCHIVE_L2B_ADDRESS}) on the replicator.`)
  }
  if (!dstOk) {
    console.log(`✗ Archive missing peer for Base Sepolia (eid ${BASE_SEPOLIA_EID}).`)
    console.log(`   Fix: setPeer(${BASE_SEPOLIA_EID}, ${CAW_ACTIONS_REPLICATOR_L2_ADDRESS}) on the archive.`)
  }
  if (srcOk && dstOk) {
    console.log(`✓ Both peers configured correctly — if replication still reverts it's a deeper LZ issue (maxMessageSize, DVN config, etc.)`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })

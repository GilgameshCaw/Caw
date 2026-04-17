// One-shot fix: re-point the L2b archive's peer for Base Sepolia to the CURRENT
// replicator. The archive's peer didn't get updated during the smltxt redeploy
// because the archive address didn't change, but the replicator did.
//
// Usage: npx tsx scripts/fix-archive-peer.ts
// Requires: VALIDATOR_PRIVATE_KEY (archive owner, same as deployer)

import 'dotenv/config'
import { JsonRpcProvider, Wallet, Contract, zeroPadValue } from 'ethers'
import {
  CAW_ACTIONS_REPLICATOR_L2_ADDRESS,
  CAW_ACTIONS_ARCHIVE_L2B_ADDRESS,
} from '../src/abi/addresses'

const ABI = [
  'function peers(uint32) view returns (bytes32)',
  'function setPeer(uint32 _eid, bytes32 _peer) external',
  'function owner() view returns (address)',
]
const BASE_SEPOLIA_EID = 40245

async function main() {
  const pk = process.env.VALIDATOR_PRIVATE_KEY || process.env.PRIVATE_KEY
  if (!pk) throw new Error('Missing VALIDATOR_PRIVATE_KEY')
  const rpc = process.env.RPC_ARBITRUM_SEPOLIA || 'https://sepolia-rollup.arbitrum.io/rpc'
  const provider = new JsonRpcProvider(rpc)
  const wallet = new Wallet(pk, provider)
  const archive = new Contract(CAW_ACTIONS_ARCHIVE_L2B_ADDRESS, ABI, wallet)

  const owner: string = await archive.owner()
  console.log(`Archive: ${CAW_ACTIONS_ARCHIVE_L2B_ADDRESS}`)
  console.log(`Archive owner: ${owner}`)
  console.log(`Signer: ${wallet.address}`)
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error('Signer is not the archive owner; setPeer will revert')
  }

  const current = await archive.peers(BASE_SEPOLIA_EID)
  const target = zeroPadValue(CAW_ACTIONS_REPLICATOR_L2_ADDRESS.toLowerCase(), 32)
  console.log(`\nCurrent peer: ${current}`)
  console.log(`Target peer:  ${target}`)
  if (current.toLowerCase() === target.toLowerCase()) {
    console.log('Already correct — nothing to do.')
    return
  }

  console.log(`\nSubmitting setPeer(${BASE_SEPOLIA_EID}, ${CAW_ACTIONS_REPLICATOR_L2_ADDRESS})...`)
  const tx = await archive.setPeer(BASE_SEPOLIA_EID, target)
  console.log(`tx: ${tx.hash}`)
  const r = await tx.wait()
  console.log(`confirmed in block ${r.blockNumber}`)

  const after = await archive.peers(BASE_SEPOLIA_EID)
  console.log(`\nPeer after update: ${after}`)
  console.log(after.toLowerCase() === target.toLowerCase() ? '✓ fixed' : '✗ still wrong')
}

main().catch(e => { console.error(e); process.exit(1) })

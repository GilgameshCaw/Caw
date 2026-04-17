// One-shot sync script: calls CawName.syncReplication on L1 Sepolia, using the
// CURRENT CawName contract (not the stale one referenced by clientManager).
// This is the workaround for the stale-clientManager.cawName() wiring — the
// current CawName's LZ peer points at the current CawNameL2, so the message
// lands on the right replicator.
//
// Usage:  npx tsx scripts/sync-replication.ts
// Env:    VALIDATOR_PRIVATE_KEY (client owner), L1_RPC_URL
//
// Reads:  clientManager.getClientChainEids(1) on L1 (includes 40231)
// Writes: CawName.syncReplication(1, 40245, 0) on L1 with LZ fee
// After the LZ message lands on L2 Base Sepolia,
// CawActionsReplicator.clientChainEnabled(1, 40231) flips to true.

import { JsonRpcProvider, Wallet, Contract, formatEther } from 'ethers'
import 'dotenv/config'
// Read addresses from the canonical addresses.ts so this script doesn't go
// stale across redeploys (it did once: previously hardcoded the FIRST-redeploy
// CawName, which silently routed sync messages through stale contracts.)
import { CAW_NAMES_ADDRESS as CAW_NAMES_L1, CAW_NAME_QUOTER_ADDRESS } from '../src/abi/addresses'
const CLIENT_ID = 1
const BASE_SEPOLIA_EID = 40245 // storage chain EID, also the LZ path CawName uses

const cawNameAbi = [
  'function syncReplication(uint32 clientId, uint32 lzDestId, uint256 lzTokenAmount) external payable',
  'function clientManager() view returns (address)',
]
const cawNameQuoterAbi = [
  'function syncReplicationQuote(uint32 clientId, uint32[] destEids, uint32 lzDestId, bool payInLzToken) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))',
]
const clientManagerAbi = [
  'function getClientChainEids(uint32) view returns (uint32[])',
]

async function main() {
  const l1Http = (process.env.L1_RPC_URL || '').replace(/^wss:/, 'https:').replace('/ws/', '/')
  const pk = process.env.VALIDATOR_PRIVATE_KEY || process.env.PRIVATE_KEY
  if (!l1Http) throw new Error('Missing L1_RPC_URL')
  if (!pk) throw new Error('Missing VALIDATOR_PRIVATE_KEY')

  const l1 = new JsonRpcProvider(l1Http)
  const wallet = new Wallet(pk, l1)
  console.log(`Signer: ${wallet.address}`)

  const cawName = new Contract(CAW_NAMES_L1, cawNameAbi, wallet)
  const quoter = new Contract(CAW_NAME_QUOTER_ADDRESS, cawNameQuoterAbi, l1)
  const clientManagerAddr: string = await cawName.clientManager()
  const clientManager = new Contract(clientManagerAddr, clientManagerAbi, l1)

  const rawDestEids = await clientManager.getClientChainEids(CLIENT_ID)
  // Clone into a plain mutable array — ethers v6 returns a frozen Result.
  const destEids: number[] = Array.from(rawDestEids, (e: any) => Number(e))
  console.log(`clientManager.getClientChainEids(${CLIENT_ID}): [${destEids.join(', ')}]`)
  if (destEids.length === 0) {
    throw new Error(`No dest eids enrolled for client ${CLIENT_ID}; cannot sync`)
  }

  const fee = await quoter.syncReplicationQuote(CLIENT_ID, destEids, BASE_SEPOLIA_EID, false)
  const nativeFee: bigint = BigInt(fee.nativeFee)
  const value = (nativeFee * 120n) / 100n // 20% buffer
  console.log(`LZ quote: ${formatEther(nativeFee)} ETH — sending ${formatEther(value)} ETH (20% buffer)`)

  const balance = await l1.getBalance(wallet.address)
  console.log(`L1 balance: ${formatEther(balance)} ETH`)
  if (balance < value) throw new Error(`Insufficient L1 balance for LZ fee`)

  console.log(`\nSubmitting syncReplication(${CLIENT_ID}, ${BASE_SEPOLIA_EID}, 0)...`)
  const tx = await cawName.syncReplication(CLIENT_ID, BASE_SEPOLIA_EID, 0, { value })
  console.log(`tx: ${tx.hash}`)

  const receipt = await tx.wait()
  console.log(`confirmed in block ${receipt.blockNumber} (gasUsed=${receipt.gasUsed})`)
  console.log(`\nWaiting for LZ delivery to Base Sepolia...`)
  console.log(`Track here: https://scan-testnet.layerzero-api.com/v1/messages/tx/${tx.hash}`)
  console.log(`Or check the L2 state in ~1–5 min with:`)
  console.log(`  npx tsx scripts/check-replication-config.ts`)
}

main().catch(err => { console.error(err); process.exit(1) })

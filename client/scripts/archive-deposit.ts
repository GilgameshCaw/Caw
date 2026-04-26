// Manual deposit helper for the optimistic archive.
//
// The validator no longer auto-restakes by default (an in-operation stake
// drop almost always means a slash; auto-topping up silently bleeds funds).
// Use this to:
//   - bootstrap a fresh validator (first deposit)
//   - re-stake after an intentional slash during testing
//
// Usage:
//   cd client
//   npx tsx scripts/archive-deposit.ts [VALIDATOR|REPLICATOR] [amountEth]
//
// Defaults: VALIDATOR, 0.02 ETH.
import 'dotenv/config'
import { ethers } from 'ethers'
import { CAW_ACTIONS_ARCHIVE_ADDRESS } from '../src/abi/addresses'

async function main() {
  const who = (process.argv[2] || 'VALIDATOR').toUpperCase()
  const amountEth = process.argv[3] || '0.02'

  const keyEnv = who === 'REPLICATOR' ? 'REPLICATOR_PRIVATE_KEY' : 'VALIDATOR_PRIVATE_KEY'
  const pk = process.env[keyEnv]
  if (!pk) throw new Error(`${keyEnv} not set in .env`)

  const rpc = process.env.L2B_RPC_URL
  if (!rpc) throw new Error('L2B_RPC_URL not set')

  const provider = new ethers.JsonRpcProvider(rpc)
  const wallet = new ethers.Wallet(pk, provider)
  const archive = new ethers.Contract(
    CAW_ACTIONS_ARCHIVE_ADDRESS,
    ['function deposit() payable', 'function stakes(address) view returns (uint256)'],
    wallet,
  )

  const before = await archive.stakes(wallet.address)
  console.log(`${who} ${wallet.address}`)
  console.log(`  stake before: ${ethers.formatEther(before)} ETH`)
  console.log(`  depositing:   ${amountEth} ETH`)

  const tx = await archive.deposit({ value: ethers.parseEther(amountEth) })
  console.log(`  tx: ${tx.hash}`)
  const rc = await tx.wait()
  if (rc?.status !== 1) throw new Error('Deposit tx failed')

  const after = await archive.stakes(wallet.address)
  console.log(`  stake after:  ${ethers.formatEther(after)} ETH`)
}

main().catch(e => { console.error(e); process.exit(1) })

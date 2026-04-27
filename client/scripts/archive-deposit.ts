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
//
// Reads REPLICATION_CHAIN from .env to pick the right archive address
// (storage chain's archive in addresses.ts is wrong when replicating
// across chains — the common case). Falls back to arbitrum-sepolia.
import 'dotenv/config'
import { ethers } from 'ethers'
import { deployments, type Env, type ChainKey } from '../src/abi/deployments'

const REPLICATION_CHAIN_META: Record<string, { env: Env; chainKey: ChainKey }> = {
  'arbitrum-sepolia': { env: 'testnet', chainKey: 'L2b' },
  'arbitrum-one':     { env: 'mainnet', chainKey: 'L2b' },
  'arbitrum':         { env: 'mainnet', chainKey: 'L2b' },
  'base-sepolia':     { env: 'testnet', chainKey: 'L2'  },
  'base':             { env: 'mainnet', chainKey: 'L2'  },
}

function resolveReplicationArchive(): string {
  const replicationChain = process.env.REPLICATION_CHAIN || 'arbitrum-sepolia'
  const meta = REPLICATION_CHAIN_META[replicationChain]
  if (!meta) {
    throw new Error(
      `REPLICATION_CHAIN="${replicationChain}" — supported keys: ${Object.keys(REPLICATION_CHAIN_META).join(', ')}`
    )
  }
  const address = deployments[meta.env]?.[meta.chainKey]?.CawActionsArchive
  if (!address) {
    throw new Error(
      `No CawActionsArchive deployment for ${meta.env}/${meta.chainKey} ` +
      `(REPLICATION_CHAIN=${replicationChain}) in client/src/abi/deployments.ts`
    )
  }
  return address
}

async function main() {
  const who = (process.argv[2] || 'VALIDATOR').toUpperCase()
  const amountEth = process.argv[3] || '0.02'

  const keyEnv = who === 'REPLICATOR' ? 'REPLICATOR_PRIVATE_KEY' : 'VALIDATOR_PRIVATE_KEY'
  const pk = process.env[keyEnv]
  if (!pk) throw new Error(`${keyEnv} not set in .env`)

  // Prefer REPLICATION_RPC (the dedicated replicator URL) when set; else
  // fall back to L2B_RPC_URL. Same precedence as ValidatorService.
  const rpc = process.env.REPLICATION_RPC || process.env.L2B_RPC_URL
  if (!rpc) throw new Error('REPLICATION_RPC (or L2B_RPC_URL) not set')

  const archiveAddress = resolveReplicationArchive()
  console.log(`Archive: ${archiveAddress} on ${process.env.REPLICATION_CHAIN || 'arbitrum-sepolia'}`)

  const provider = new ethers.JsonRpcProvider(rpc)
  const wallet = new ethers.Wallet(pk, provider)
  const archive = new ethers.Contract(
    archiveAddress,
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

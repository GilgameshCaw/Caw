/**
 * Check Replication Status Script
 *
 * Displays the current replication configuration for a CAW client on both L1 and L2.
 *
 * Usage:
 *   npx tsx scripts/check-replication.ts <clientId>
 *
 * Example:
 *   npx tsx scripts/check-replication.ts 1
 */

import 'dotenv/config'
import { JsonRpcProvider, Contract } from 'ethers'
import { cawClientManagerAbi, cawActionsReplicatorAbi } from '../src/abi/generated'
import { CLIENT_MANAGER_ADDRESS, CAW_ACTIONS_REPLICATOR_L2_ADDRESS } from '../src/abi/addresses'

// LayerZero EID to chain name mapping
const EID_NAMES: Record<number, string> = {
  30101: 'Ethereum Mainnet',
  30184: 'Base',
  30110: 'Arbitrum',
  30111: 'Optimism',
  40161: 'Sepolia',
  40231: 'Arbitrum Sepolia',
  40245: 'Base Sepolia',
}

async function main() {
  const clientId = parseInt(process.argv[2])

  if (isNaN(clientId) || clientId < 1) {
    console.log('Usage: npx tsx scripts/check-replication.ts <clientId>')
    console.log('')
    console.log('Example:')
    console.log('  npx tsx scripts/check-replication.ts 1')
    process.exit(1)
  }

  console.log('='.repeat(60))
  console.log(`CAW Replication Status - Client ${clientId}`)
  console.log('='.repeat(60))
  console.log('')

  // Setup providers (both required — no hardcoded fallbacks to avoid
  // committing API keys)
  const l1RpcUrl = process.env.L1_RPC_URL_HTTP
  const l2RpcUrl = process.env.L2_RPC_URL_HTTP
  if (!l1RpcUrl || !l2RpcUrl) {
    console.error('Error: L1_RPC_URL_HTTP and L2_RPC_URL_HTTP must be set in your .env file')
    process.exit(1)
  }

  const l1Provider = new JsonRpcProvider(l1RpcUrl)
  const l2Provider = new JsonRpcProvider(l2RpcUrl)

  // L1 - CawClientManager
  console.log('L1 (CawClientManager):')
  console.log(`  Contract: ${CLIENT_MANAGER_ADDRESS}`)

  try {
    const clientManager = new Contract(CLIENT_MANAGER_ADDRESS, cawClientManagerAbi, l1Provider)

    const owner = await clientManager.getClientOwner(clientId)
    console.log(`  Client Owner: ${owner}`)

    if (owner === '0x0000000000000000000000000000000000000000') {
      console.log(`  Status: Client ${clientId} does not exist`)
      process.exit(0)
    }

    const enabled = await clientManager.clientReplicationEnabled(clientId)
    console.log(`  Replication Enabled: ${enabled}`)

    const replications = await clientManager.getReplications(clientId)
    console.log(`  Replication Destinations: ${replications.length}`)

    if (replications.length > 0) {
      for (const rep of replications) {
        const chainName = EID_NAMES[Number(rep.eid)] || `Unknown (${rep.eid})`
        console.log(`    - ${chainName} (EID ${rep.eid})`)
        console.log(`      Target: ${rep.target}`)
      }
    } else {
      console.log('    (none)')
    }
  } catch (err: any) {
    console.log(`  Error: ${err.message}`)
  }

  // L2 - CawActionsReplicator
  console.log('')
  console.log('L2 (CawActionsReplicator):')
  console.log(`  Contract: ${CAW_ACTIONS_REPLICATOR_L2_ADDRESS}`)

  try {
    const replicator = new Contract(CAW_ACTIONS_REPLICATOR_L2_ADDRESS, cawActionsReplicatorAbi, l2Provider)

    const enabled = await replicator.clientReplicationEnabled(clientId)
    console.log(`  Replication Enabled: ${enabled}`)

    const replications = await replicator.getReplicationDestinations(clientId)
    console.log(`  Replication Destinations: ${replications.length}`)

    if (replications.length > 0) {
      for (const rep of replications) {
        const chainName = EID_NAMES[Number(rep.eid)] || `Unknown (${rep.eid})`
        console.log(`    - ${chainName} (EID ${rep.eid})`)
        console.log(`      Target: ${rep.target}`)
      }
    } else {
      console.log('    (none)')
    }
  } catch (err: any) {
    console.log(`  Error: ${err.message}`)
  }

  console.log('')
  console.log('='.repeat(60))

  // Summary
  console.log('')
  console.log('Note: If L1 and L2 configs differ, the sync may be in progress.')
  console.log('LayerZero cross-chain messages typically take 1-5 minutes.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
  })

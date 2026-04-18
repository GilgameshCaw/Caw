/**
 * Add Replication Script
 *
 * Enables cross-chain replication for a CAW client by:
 * 1. Adding a replication destination to the CawClientManager on L1
 * 2. Waiting for the config to sync to L2 via LayerZero
 * 3. Migrating all historical actions to the new archive chain
 *
 * Usage:
 *   npx tsx scripts/add-replication.ts <clientId> <archiveEid> [archiveAddress]
 *
 * Example:
 *   npx tsx scripts/add-replication.ts 1 40231 0x56817dc696448135203C0556f702c6a953260411
 *
 * Common LayerZero Endpoint IDs:
 *   - Ethereum Mainnet: 30101
 *   - Base: 30184
 *   - Arbitrum: 30110
 *   - Optimism: 30111
 *   - Arbitrum Sepolia: 40231
 *   - Base Sepolia: 40245
 *   - Sepolia: 40161
 */

import 'dotenv/config'
import { JsonRpcProvider, Wallet, Contract, formatEther, Interface } from 'ethers'
import { cawClientManagerAbi, cawProfileQuoterAbi, cawActionsAbi, cawActionsReplicatorAbi } from '../src/abi/generated'
import { CLIENT_MANAGER_ADDRESS, CAW_ACTIONS_ARCHIVE_L2_ADDRESS, CAW_NAME_QUOTER_ADDRESS, CAW_ACTIONS_ADDRESS, CAW_ACTIONS_REPLICATOR_L2_ADDRESS } from '../src/abi/addresses'

// Known archive addresses (add more as needed)
const KNOWN_ARCHIVES: Record<number, string> = {
  // Add known archive contract addresses by eid here
}

// How many actions to migrate per batch (gas limit considerations)
const MIGRATION_BATCH_SIZE = 50

interface ActionData {
  actionType: number
  senderId: number
  receiverId: number
  receiverCawonce: number
  clientId: number
  cawonce: number
  recipients: number[]
  amounts: bigint[]
  text: string
}

interface SignedAction {
  action: ActionData
  v: number
  r: string
  s: string
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const skipSync = args.includes('--skip-sync') || dryRun
  const filteredArgs = args.filter(a => !a.startsWith('--'))

  if (filteredArgs.length < 2) {
    console.log('Usage: npx tsx scripts/add-replication.ts <clientId> <archiveEid> [archiveAddress]')
    console.log('')
    console.log('Arguments:')
    console.log('  clientId       - Your CAW client ID (e.g., 1)')
    console.log('  archiveEid     - LayerZero endpoint ID of the archive chain')
    console.log('  archiveAddress - (Optional) CawActionsArchive contract address')
    console.log('')
    console.log('Common LayerZero Endpoint IDs:')
    console.log('  40231 - Arbitrum Sepolia')
    console.log('  40245 - Base Sepolia')
    console.log('  40161 - Sepolia')
    console.log('  30101 - Ethereum Mainnet')
    console.log('  30184 - Base')
    console.log('  30110 - Arbitrum')
    process.exit(1)
  }

  const clientId = parseInt(filteredArgs[0])
  const archiveEid = parseInt(filteredArgs[1])
  let archiveAddress = filteredArgs[2] || KNOWN_ARCHIVES[archiveEid] || CAW_ACTIONS_ARCHIVE_L2_ADDRESS

  if (!archiveAddress) {
    console.error('Error: No archive address provided and no known address for eid', archiveEid)
    process.exit(1)
  }

  // Validate inputs
  if (isNaN(clientId) || clientId < 1) {
    console.error('Error: Invalid client ID')
    process.exit(1)
  }
  if (isNaN(archiveEid) || archiveEid < 1) {
    console.error('Error: Invalid archive endpoint ID')
    process.exit(1)
  }
  if (!archiveAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
    console.error('Error: Invalid archive address')
    process.exit(1)
  }

  console.log('='.repeat(60))
  console.log('CAW Add Replication with Historical Migration')
  console.log('='.repeat(60))
  console.log('')
  console.log('Configuration:')
  console.log(`  Client ID:        ${clientId}`)
  console.log(`  Archive EID:      ${archiveEid}`)
  console.log(`  Archive Address:  ${archiveAddress}`)
  console.log(`  Client Manager:   ${CLIENT_MANAGER_ADDRESS}`)
  console.log('')

  // Check for private key
  const privateKey = process.env.VALIDATOR_PRIVATE_KEY || process.env.PRIVATE_KEY
  if (!privateKey) {
    console.error('Error: No private key found in environment')
    console.error('Set VALIDATOR_PRIVATE_KEY or PRIVATE_KEY in your .env file')
    process.exit(1)
  }

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
  const l1Wallet = new Wallet(privateKey, l1Provider)
  const l2Wallet = new Wallet(privateKey, l2Provider)

  console.log(`Wallet Address: ${l1Wallet.address}`)

  // Check balances
  const l1Balance = await l1Provider.getBalance(l1Wallet.address)
  const l2Balance = await l2Provider.getBalance(l2Wallet.address)
  console.log(`L1 ETH Balance: ${formatEther(l1Balance)} ETH`)
  console.log(`L2 ETH Balance: ${formatEther(l2Balance)} ETH`)

  if (l1Balance === 0n) {
    console.error('Error: Wallet has no ETH on L1 for gas')
    process.exit(1)
  }

  // Setup contracts
  const clientManager = new Contract(CLIENT_MANAGER_ADDRESS, cawClientManagerAbi, l1Wallet)
  const cawActions = new Contract(CAW_ACTIONS_ADDRESS, cawActionsAbi, l2Provider)
  const replicator = new Contract(CAW_ACTIONS_REPLICATOR_L2_ADDRESS, cawActionsReplicatorAbi, l2Wallet)

  // Check current state on L1
  console.log('')
  console.log('Checking current state on L1...')

  let needsReplication = true
  try {
    const owner = await clientManager.getClientOwner(clientId)
    console.log(`  Client ${clientId} Owner: ${owner}`)

    if (owner === '0x0000000000000000000000000000000000000000') {
      console.error(`Error: Client ${clientId} does not exist`)
      process.exit(1)
    }

    if (owner.toLowerCase() !== l1Wallet.address.toLowerCase()) {
      console.error(`Error: You are not the owner of client ${clientId}`)
      console.error(`  Owner: ${owner}`)
      console.error(`  Your wallet: ${l1Wallet.address}`)
      process.exit(1)
    }

    const replicationEnabled = await clientManager.clientReplicationEnabled(clientId)
    console.log(`  Replication Enabled: ${replicationEnabled}`)

    const replications = await clientManager.getReplications(clientId)
    console.log(`  Current Replications: ${replications.length}`)

    for (const rep of replications) {
      console.log(`    - EID ${rep.eid}: ${rep.target}`)
      if (Number(rep.eid) === archiveEid) {
        console.log(`  Replication to EID ${archiveEid} already exists on L1`)
        needsReplication = false
      }
    }

    if (needsReplication && replications.length >= 4) {
      console.error('Error: Maximum 4 replication destinations reached')
      process.exit(1)
    }
  } catch (err: any) {
    console.error('Error checking L1 state:', err.message)
    process.exit(1)
  }

  // Check action count for migration
  console.log('')
  console.log('Checking historical actions for migration...')

  const actionCount = Number(await cawActions.clientActionCount(clientId))
  const checkpointCount = Math.floor(actionCount / 256)
  const partialCheckpointActions = actionCount % 256

  console.log(`  Total Actions: ${actionCount}`)
  console.log(`  Complete Checkpoints: ${checkpointCount}`)
  console.log(`  Actions in Partial Checkpoint: ${partialCheckpointActions}`)

  if (actionCount === 0) {
    console.log('  No historical actions to migrate')
  }

  // Step 1: Add replication on L1 if needed
  if (needsReplication) {
    console.log('')
    console.log('Step 1: Adding replication destination on L1...')

    // Get quote for LayerZero fee using client's storage chain
    const storageChainEid = await clientManager.getStorageChainEid(clientId)
    console.log(`  Client Storage Chain EID: ${storageChainEid}`)

    let quote: { nativeFee: bigint; lzTokenFee: bigint }
    try {
      const quoter = new Contract(CAW_NAME_QUOTER_ADDRESS, cawProfileQuoterAbi, l1Provider)
      quote = await quoter.syncReplicationQuote(
        clientId,
        [archiveEid],
        storageChainEid,
        false
      )
      console.log(`  LayerZero Fee: ${formatEther(quote.nativeFee)} ETH`)
    } catch (err: any) {
      console.error('Error getting quote:', err.message)
      console.log('This may mean the LayerZero path is not configured.')
      process.exit(1)
    }

    // Add buffer to fee (10% extra)
    const feeWithBuffer = (quote.nativeFee * 110n) / 100n

    if (l1Balance < feeWithBuffer) {
      console.error(`Error: Insufficient ETH for LayerZero fee`)
      process.exit(1)
    }

    console.log('')
    console.log('Ready to add replication!')
    console.log(`  Will send ~${formatEther(feeWithBuffer)} ETH for LayerZero fees`)

    if (dryRun) {
      console.log('')
      console.log('[DRY RUN] Would send addReplication transaction')
      console.log('[DRY RUN] Exiting without making changes')
      process.exit(0)
    }

    console.log('')
    console.log('Press Ctrl+C to cancel, or wait 5 seconds to proceed...')
    await sleep(5000)

    console.log('')
    console.log('Sending addReplication transaction...')

    try {
      const tx = await clientManager.addReplication(clientId, archiveEid, {
        value: feeWithBuffer
      })

      console.log(`  Transaction Hash: ${tx.hash}`)
      console.log('  Waiting for confirmation...')

      const receipt = await tx.wait()
      console.log(`  Confirmed in block ${receipt.blockNumber}`)
    } catch (err: any) {
      console.error('Transaction failed:', err.message)
      process.exit(1)
    }

    // Wait for L2 sync
    console.log('')
    console.log('Step 2: Waiting for config to sync to L2...')
    console.log('  (This may take 1-5 minutes via LayerZero)')

    let syncAttempts = 0
    const maxSyncAttempts = 60 // 5 minutes max

    while (syncAttempts < maxSyncAttempts) {
      try {
        const l2Enabled = await replicator.clientReplicationEnabled(clientId)
        const l2Replications = await replicator.getReplicationDestinations(clientId)

        const found = l2Replications.some((rep: any) => Number(rep.eid) === archiveEid)

        if (l2Enabled && found) {
          console.log('  Config synced to L2 successfully!')
          break
        }
      } catch (err) {
        // Ignore errors during polling
      }

      syncAttempts++
      process.stdout.write(`  Checking... (${syncAttempts * 5}s elapsed)\r`)
      await sleep(5000)
    }

    if (syncAttempts >= maxSyncAttempts) {
      console.log('')
      console.log('Warning: L2 sync not confirmed after 5 minutes')
      console.log('The config may still sync. Check manually with:')
      console.log(`  npx tsx scripts/check-replication.ts ${clientId}`)
      console.log('')
      console.log('Migration will be skipped. Run this script again once sync is confirmed.')
      process.exit(0)
    }
  } else {
    console.log('')
    console.log('Step 1: Replication already configured on L1, skipping...')

    // Verify L2 is synced
    console.log('')
    console.log('Step 2: Verifying L2 sync...')
    try {
      const l2Enabled = await replicator.clientReplicationEnabled(clientId)
      const l2Replications = await replicator.getReplicationDestinations(clientId)
      const found = l2Replications.some((rep: any) => Number(rep.eid) === archiveEid)

      if (!l2Enabled || !found) {
        if (skipSync) {
          console.log('  Warning: L2 not synced yet')
          console.log('  --skip-sync specified, continuing anyway...')
          console.log('  NOTE: Migration will fail if L2 sync is not complete')
        } else {
          console.log('  Warning: L2 not synced yet. Waiting...')

          let syncAttempts = 0
          while (syncAttempts < 60) {
            await sleep(5000)
            const enabled = await replicator.clientReplicationEnabled(clientId)
            const reps = await replicator.getReplicationDestinations(clientId)
            if (enabled && reps.some((r: any) => Number(r.eid) === archiveEid)) {
              console.log('  L2 synced!')
              break
            }
            syncAttempts++
            process.stdout.write(`  Checking... (${syncAttempts * 5}s elapsed)\r`)
          }
        }
      } else {
        console.log('  L2 is synced')
      }
    } catch (err: any) {
      console.error('Error checking L2:', err.message)
      process.exit(1)
    }
  }

  // Step 3: Migrate historical actions
  if (actionCount === 0) {
    console.log('')
    console.log('Step 3: No historical actions to migrate')
    console.log('')
    console.log('='.repeat(60))
    console.log('SUCCESS! Replication enabled.')
    console.log('New actions will be automatically replicated.')
    console.log('='.repeat(60))
    process.exit(0)
  }

  console.log('')
  console.log('Step 3: Migrating historical actions...')
  console.log('')

  // Check L2 balance for migration
  if (l2Balance === 0n) {
    console.error('Error: Wallet has no ETH on L2 for migration transactions')
    console.log('Please fund the wallet on L2 and run this script again.')
    process.exit(1)
  }

  // Fetch all historical transactions with signatures from blockchain
  console.log('Fetching historical action transactions from blockchain...')

  const iface = new Interface(cawActionsAbi)
  const processActionsSelector = iface.getFunction('processActions')!.selector

  // Find all processActions transactions for this client
  const signedActions: SignedAction[] = []

  // Query ActionsProcessed events to find transactions
  const filter = cawActions.filters.ActionsProcessed()
  const events = await cawActions.queryFilter(filter, 0, 'latest')

  console.log(`  Found ${events.length} ActionsProcessed events`)

  // Group events by transaction hash to batch fetch
  const txHashes = [...new Set(events.map(e => e.transactionHash))]
  console.log(`  From ${txHashes.length} unique transactions`)

  // Fetch transaction data and decode
  let fetchedCount = 0
  for (const txHash of txHashes) {
    try {
      const tx = await l2Provider.getTransaction(txHash)
      if (!tx || !tx.data.startsWith(processActionsSelector)) continue

      // Decode the transaction input
      const decoded = iface.parseTransaction({ data: tx.data })
      if (!decoded) continue

      const data = decoded.args[1] // MultiActionData is second arg
      const actions = data.actions as any[]
      const vArray = data.v as number[]
      const rArray = data.r as string[]
      const sArray = data.s as string[]

      // Filter for our client's actions
      for (let i = 0; i < actions.length; i++) {
        const action = actions[i]
        if (Number(action.clientId) === clientId) {
          signedActions.push({
            action: {
              actionType: Number(action.actionType),
              senderId: Number(action.senderId),
              receiverId: Number(action.receiverId),
              receiverCawonce: Number(action.receiverCawonce),
              clientId: Number(action.clientId),
              cawonce: Number(action.cawonce),
              recipients: action.recipients.map((r: any) => Number(r)),
              amounts: action.amounts.map((a: any) => BigInt(a)),
              text: action.text
            },
            v: vArray[i],
            r: rArray[i],
            s: sArray[i]
          })
        }
      }

      fetchedCount++
      if (fetchedCount % 10 === 0) {
        process.stdout.write(`  Processed ${fetchedCount}/${txHashes.length} transactions...\r`)
      }
    } catch (err) {
      // Skip failed fetches
    }
  }

  console.log(`  Retrieved ${signedActions.length} signed actions for client ${clientId}`)

  if (signedActions.length === 0) {
    console.log('  No actions found for migration')
    console.log('')
    console.log('='.repeat(60))
    console.log('SUCCESS! Replication enabled.')
    console.log('='.repeat(60))
    process.exit(0)
  }

  // Sort actions by the order they were processed (use indexOf from original fetch order)
  // The order matters for hash chain verification
  signedActions.sort((a, b) => a.action.cawonce - b.action.cawonce)

  console.log(`  Total actions to migrate: ${signedActions.length}`)

  // Separate complete checkpoints from partial checkpoint
  const completeCheckpoints = checkpointCount
  const partialActions = signedActions.slice(completeCheckpoints * 256)
  const completeActions = signedActions.slice(0, completeCheckpoints * 256)

  console.log(`  Complete checkpoints: ${completeCheckpoints} (${completeActions.length} actions)`)
  console.log(`  Partial checkpoint: ${partialActions.length} actions`)

  let migratedCount = 0

  // Step 3a: Migrate complete checkpoints using migrateHistoricalBatch
  for (let cp = 1; cp <= completeCheckpoints; cp++) {
    const cpActions = signedActions.slice((cp - 1) * 256, cp * 256)

    console.log('')
    console.log(`Migrating checkpoint ${cp} (${cpActions.length} actions)...`)

    // Build allR array for this checkpoint
    const allR: string[] = cpActions.map(sa => sa.r)
    while (allR.length < 256) {
      allR.push('0x' + '00'.repeat(32))
    }

    // Migrate in batches within the checkpoint
    for (let offset = 0; offset < cpActions.length; offset += MIGRATION_BATCH_SIZE) {
      const batch = cpActions.slice(offset, Math.min(offset + MIGRATION_BATCH_SIZE, cpActions.length))

      console.log(`  Batch at offset ${offset}: ${batch.length} actions`)

      const migrationActions = batch.map(sa => sa.action)
      const vArray = batch.map(sa => sa.v)
      const rArray = batch.map(sa => sa.r)
      const sArray = batch.map(sa => sa.s)

      const params = {
        clientId,
        destEid: archiveEid,
        checkpointId: cp,
        offset,
        lzTokenAmount: 0
      }

      // Get quote
      const avgTextLength = Math.ceil(
        batch.reduce((sum, sa) => sum + sa.action.text.length, 0) / batch.length
      )

      let fee: bigint
      try {
        const quote = await replicator.quoteMigration(archiveEid, batch.length, avgTextLength, false)
        fee = quote.nativeFee
        console.log(`    Fee: ${formatEther(fee)} ETH`)
      } catch {
        fee = BigInt(batch.length) * 100000000000000n
        console.log(`    Fee (estimated): ${formatEther(fee)} ETH`)
      }

      const feeWithBuffer = (fee * 150n) / 100n

      if (dryRun) {
        console.log(`    [DRY RUN] Would call migrateHistoricalBatch`)
        migratedCount += batch.length
        continue
      }

      try {
        const tx = await replicator.migrateHistoricalBatch(
          params,
          migrationActions,
          vArray,
          rArray,
          sArray,
          allR,
          { value: feeWithBuffer }
        )
        console.log(`    Transaction: ${tx.hash}`)
        await tx.wait()
        migratedCount += batch.length
      } catch (err: any) {
        console.log(`    Failed: ${err.reason || err.message}`)
      }
    }
  }

  // Step 3b: Migrate partial checkpoint using migratePartialCheckpoint
  if (partialActions.length > 0) {
    console.log('')
    console.log(`Migrating partial checkpoint (${partialActions.length} actions)...`)

    const migrationActions = partialActions.map(sa => sa.action)
    const vArray = partialActions.map(sa => sa.v)
    const rArray = partialActions.map(sa => sa.r)
    const sArray = partialActions.map(sa => sa.s)

    const avgTextLength = Math.ceil(
      partialActions.reduce((sum, sa) => sum + sa.action.text.length, 0) / partialActions.length
    )

    let fee: bigint
    try {
      const quote = await replicator.quoteMigration(archiveEid, partialActions.length, avgTextLength, false)
      fee = quote.nativeFee
      console.log(`  Fee: ${formatEther(fee)} ETH`)
    } catch {
      fee = BigInt(partialActions.length) * 100000000000000n
      console.log(`  Fee (estimated): ${formatEther(fee)} ETH`)
    }

    const feeWithBuffer = (fee * 150n) / 100n

    if (dryRun) {
      console.log(`  [DRY RUN] Would call migratePartialCheckpoint with ${partialActions.length} actions`)
      console.log(`  [DRY RUN] Fee: ~${formatEther(feeWithBuffer)} ETH`)
      migratedCount += partialActions.length
    } else {
      try {
        const tx = await replicator.migratePartialCheckpoint(
          clientId,
          archiveEid,
          migrationActions,
          vArray,
          rArray,
          sArray,
          { value: feeWithBuffer }
        )

        console.log(`  Transaction: ${tx.hash}`)
        const receipt = await tx.wait()
        console.log(`  Confirmed in block ${receipt.blockNumber}`)

        migratedCount += partialActions.length
      } catch (err: any) {
        console.log(`  Migration failed: ${err.message}`)
        if (err.reason) {
          console.log(`  Reason: ${err.reason}`)
        }
      }
    }
  }

  console.log('')
  console.log('='.repeat(60))
  console.log('COMPLETE!')
  console.log('')
  console.log(`  Replication Destination: EID ${archiveEid}`)
  console.log(`  Historical Actions Migrated: ${migratedCount}/${signedActions.length}`)
  console.log('')
  console.log('New actions will be automatically replicated.')
  console.log('='.repeat(60))
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
  })

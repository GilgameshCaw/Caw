/**
 * Seed Client.creationBlock in the DB for a given networkId.
 *
 * RawEventsGatherer uses Client.creationBlock as its L2 indexer fresh-DB
 * start block. The on-chain CawNetwork struct will carry this field once
 * the contract is redeployed; until then, populate manually here.
 *
 * USAGE:
 *   npx tsx scripts/seed-network-creation-block.ts <networkId> <l2BlockNumber>
 *
 * The l2BlockNumber should be the L2 (e.g. Base Sepolia) block from which
 * you want the indexer to start scanning for this Network's actions. For
 * the initial Network, this is typically the L2 CawActions deploy block
 * (see .deploy-state.json::l2DeployBlock).
 */
import { prisma } from '../src/prismaClient'

async function main() {
  const [networkIdArg, blockArg] = process.argv.slice(2)

  if (!networkIdArg || !blockArg) {
    console.error('Usage: npx tsx scripts/seed-network-creation-block.ts <networkId> <l2BlockNumber>')
    process.exit(1)
  }

  const networkId = Number(networkIdArg)
  const blockNumber = BigInt(blockArg)

  if (!Number.isFinite(networkId) || networkId <= 0) {
    console.error(`Invalid networkId: ${networkIdArg}`)
    process.exit(1)
  }

  const existing = await prisma.client.findUnique({ where: { id: networkId } })

  if (existing) {
    const previous = existing.creationBlock
    await prisma.client.update({
      where: { id: networkId },
      data: { creationBlock: blockNumber },
    })
    console.log(`Updated networkId=${networkId} creationBlock: ${previous ?? '(null)'} → ${blockNumber}`)
  } else {
    await prisma.client.create({
      data: {
        id: networkId,
        creationBlock: blockNumber,
        // Placeholder addresses — ChainSyncService will fill these in when
        // it next syncs the Network from CawNetworkManager.
        ownerAddress: '',
        feeAddress: '',
      },
    })
    console.log(`Created networkId=${networkId} with creationBlock=${blockNumber}`)
    console.log('NOTE: ownerAddress + feeAddress are placeholders. ChainSyncService will populate them on next sync.')
  }

  await prisma.$disconnect()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

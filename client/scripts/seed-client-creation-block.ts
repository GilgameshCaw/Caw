/**
 * Seed Client.creationBlock in the DB for a given clientId.
 *
 * RawEventsGatherer uses Client.creationBlock as its L2 indexer fresh-DB
 * start block. The on-chain CawClient struct will carry this field once
 * the contract is redeployed; until then, populate manually here.
 *
 * USAGE:
 *   npx tsx scripts/seed-client-creation-block.ts <clientId> <l2BlockNumber>
 *
 * The l2BlockNumber should be the L2 (e.g. Base Sepolia) block from which
 * you want the indexer to start scanning for this client's actions. For
 * the initial client, this is typically the L2 CawActions deploy block
 * (see .deploy-state.json::l2DeployBlock).
 */
import { prisma } from '../src/prismaClient'

async function main() {
  const [clientIdArg, blockArg] = process.argv.slice(2)

  if (!clientIdArg || !blockArg) {
    console.error('Usage: npx tsx scripts/seed-client-creation-block.ts <clientId> <l2BlockNumber>')
    process.exit(1)
  }

  const clientId = Number(clientIdArg)
  const blockNumber = BigInt(blockArg)

  if (!Number.isFinite(clientId) || clientId <= 0) {
    console.error(`Invalid clientId: ${clientIdArg}`)
    process.exit(1)
  }

  const existing = await prisma.client.findUnique({ where: { id: clientId } })

  if (existing) {
    const previous = existing.creationBlock
    await prisma.client.update({
      where: { id: clientId },
      data: { creationBlock: blockNumber },
    })
    console.log(`Updated clientId=${clientId} creationBlock: ${previous ?? '(null)'} → ${blockNumber}`)
  } else {
    await prisma.client.create({
      data: {
        id: clientId,
        creationBlock: blockNumber,
        // Placeholder addresses — ChainSyncService will fill these in when
        // it next syncs the client from CawClientManager.
        ownerAddress: '',
        feeAddress: '',
      },
    })
    console.log(`Created clientId=${clientId} with creationBlock=${blockNumber}`)
    console.log('NOTE: ownerAddress + feeAddress are placeholders. ChainSyncService will populate them on next sync.')
  }

  await prisma.$disconnect()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

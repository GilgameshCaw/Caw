// scripts/reset-stuck-processing.ts
// Reset transactions stuck in "processing" status back to "pending"

import { prisma } from '../src/prismaClient'

async function resetStuckProcessing() {
  console.log('Finding transactions stuck in processing...\n')

  const stuck = await prisma.txQueue.findMany({
    where: { status: 'processing' },
    orderBy: { createdAt: 'desc' }
  })

  if (stuck.length === 0) {
    console.log('No stuck transactions found!')
    await prisma.$disconnect()
    return
  }

  console.log(`Found ${stuck.length} stuck transaction(s):\n`)

  stuck.forEach(tx => {
    const payload = tx.payload as any
    const actionType = payload?.data?.actionType
    const actionName = ['CAW', 'LIKE', 'UNLIKE', 'RECAW', 'FOLLOW', 'UNFOLLOW', 'WITHDRAW', 'OTHER'][actionType] || 'UNKNOWN'
    console.log(`  - ID ${tx.id}: ${actionName} from user ${tx.senderId}, created ${tx.createdAt}`)
  })

  console.log('\nResetting to "pending" status...')

  const result = await prisma.txQueue.updateMany({
    where: { status: 'processing' },
    data: { status: 'pending' }
  })

  console.log(`\n✅ Reset ${result.count} transaction(s) back to pending`)
  console.log('The validator will retry them on the next cycle.')

  await prisma.$disconnect()
}

resetStuckProcessing()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error)
    process.exit(1)
  })

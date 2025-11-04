// scripts/check-txqueue.ts
import { prisma } from '../src/prismaClient'

async function checkTxQueue() {
  console.log('Checking TxQueue status...\n')

  const processing = await prisma.txQueue.findMany({
    where: { status: 'processing' },
    orderBy: { createdAt: 'desc' }
  })

  const pending = await prisma.txQueue.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'desc' },
    take: 5
  })

  const failed = await prisma.txQueue.findMany({
    where: { status: 'failed' },
    orderBy: { createdAt: 'desc' },
    take: 5
  })

  console.log(`Processing: ${processing.length}`)
  if (processing.length > 0) {
    processing.forEach(tx => {
      const payload = tx.payload as any
      console.log(`  - ID ${tx.id}: Sender ${tx.senderId}, Action: ${payload?.data?.actionType}, Created: ${tx.createdAt}`)
    })
  }

  console.log(`\nPending: ${pending.length}`)
  if (pending.length > 0) {
    pending.forEach(tx => {
      const payload = tx.payload as any
      console.log(`  - ID ${tx.id}: Sender ${tx.senderId}, Action: ${payload?.data?.actionType}, Created: ${tx.createdAt}`)
    })
  }

  console.log(`\nFailed: ${failed.length}`)
  if (failed.length > 0) {
    failed.forEach(tx => {
      const payload = tx.payload as any
      console.log(`  - ID ${tx.id}: Sender ${tx.senderId}, Reason: ${tx.reason}, Created: ${tx.createdAt}`)
    })
  }

  await prisma.$disconnect()
}

checkTxQueue()

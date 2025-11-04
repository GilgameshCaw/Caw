// Reset TxQueue entries stuck in 'processing' status back to 'pending'
import { prisma } from '../src/prismaClient'

async function main() {
  console.log('Checking for TxQueue entries stuck in processing...')

  const processingEntries = await prisma.txQueue.findMany({
    where: { status: 'processing' }
  })

  console.log(`Found ${processingEntries.length} entries in 'processing' status`)

  if (processingEntries.length === 0) {
    console.log('No entries to reset')
    return
  }

  processingEntries.forEach(entry => {
    const data = (entry.payload as any).data
    console.log(`  - ID: ${entry.id}, Sender: ${data.senderId}, Cawonce: ${data.cawonce}, ActionType: ${data.actionType}`)
  })

  const result = await prisma.txQueue.updateMany({
    where: { status: 'processing' },
    data: { status: 'pending' }
  })

  console.log(`\nReset ${result.count} entries from 'processing' to 'pending'`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error:', err)
    process.exit(1)
  })

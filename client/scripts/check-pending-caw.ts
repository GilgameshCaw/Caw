import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function checkPendingCaw() {
  console.log('=== Checking Latest TxQueue and Caw Entries ===\n')

  // Get latest TxQueue entries
  const latestTxQueue = await prisma.txQueue.findMany({
    orderBy: { id: 'desc' },
    take: 5,
    select: {
      id: true,
      senderId: true,
      status: true,
      createdAt: true,
      payload: true
    }
  })

  console.log('Latest TxQueue entries:')
  for (const tx of latestTxQueue) {
    const data = (tx.payload as any)?.data
    console.log(`  ID: ${tx.id}, Status: ${tx.status}, SenderId: ${tx.senderId}`)
    if (data) {
      console.log(`    ActionType: ${data.actionType}, Cawonce: ${data.cawonce}`)
      if (data.actionType === 0 || data.actionType === 'caw') {
        // Check if corresponding pending caw exists
        const pendingCaw = await prisma.caw.findUnique({
          where: {
            userId_cawonce: {
              userId: data.senderId,
              cawonce: data.cawonce
            }
          }
        })
        if (pendingCaw) {
          console.log(`    ✅ Pending caw exists: ID ${pendingCaw.id}, Status: ${pendingCaw.status}`)
        } else {
          console.log(`    ❌ NO PENDING CAW FOUND for userId: ${data.senderId}, cawonce: ${data.cawonce}`)
        }
      }
    }
    console.log()
  }

  // Get latest Caw entries
  console.log('\nLatest Caw entries:')
  const latestCaws = await prisma.caw.findMany({
    orderBy: { id: 'desc' },
    take: 5,
    select: {
      id: true,
      userId: true,
      cawonce: true,
      status: true,
      content: true,
      createdAt: true
    }
  })

  for (const caw of latestCaws) {
    console.log(`  ID: ${caw.id}, User: ${caw.userId}, Cawonce: ${caw.cawonce}, Status: ${caw.status}`)
    console.log(`    Content: ${caw.content?.substring(0, 50)}...`)
  }

  await prisma.$disconnect()
}

checkPendingCaw().catch(console.error)
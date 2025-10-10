const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkPendingCaws() {
  try {
    // Get all pending caws
    const pendingCaws = await prisma.caw.findMany({
      where: {
        status: 'PENDING'
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: 10
    });

    console.log(`\n=== Found ${pendingCaws.length} PENDING caws ===`);
    pendingCaws.forEach(caw => {
      console.log(`
ID: ${caw.id}
User: ${caw.userId}
Cawonce: ${caw.cawonce}
Text: ${caw.text}
Created: ${caw.createdAt}
Status: ${caw.status}
---`);
    });

    // Check for any successful caws with same userId/cawonce
    for (const caw of pendingCaws) {
      const existingSuccess = await prisma.caw.findFirst({
        where: {
          userId: caw.userId,
          cawonce: caw.cawonce,
          status: 'SUCCESS'
        }
      });

      if (existingSuccess) {
        console.log(`\n⚠️  Caw ${caw.id} should be removed - already exists as SUCCESS with id ${existingSuccess.id}`);
      }
    }

    // Check the latest TxQueue records
    const latestTxQueue = await prisma.txQueue.findMany({
      orderBy: {
        createdAt: 'desc'
      },
      take: 5
    });

    console.log(`\n=== Latest TxQueue Records ===`);
    latestTxQueue.forEach(tx => {
      const payload = tx.payload;
      console.log(`
ID: ${tx.id}
Status: ${tx.status}
Created: ${tx.createdAt}
Sender: ${payload?.data?.senderId}
Cawonce: ${payload?.data?.cawonce}
ActionType: ${payload?.data?.actionType}
---`);
    });

  } catch (error) {
    console.error('Error checking pending caws:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkPendingCaws();
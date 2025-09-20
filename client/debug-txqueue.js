const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function debug() {
  console.log('\n=== Recent TxQueue Entries ===');
  const txQueue = await prisma.txQueue.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5
  });

  for (const tx of txQueue) {
    const data = tx.payload.data;
    console.log(`\nID: ${tx.id}`);
    console.log(`Status: ${tx.status}`);
    console.log(`Reason: ${tx.reason || 'N/A'}`);
    console.log(`SenderId: ${tx.senderId}`);
    console.log(`ActionType: ${data.actionType} (0=CAW, 1=LIKE)`);
    console.log(`Cawonce: ${data.cawonce}`);
    console.log(`Text: ${data.text || 'N/A'}`);
    console.log(`CreatedAt: ${tx.createdAt}`);
  }

  console.log('\n=== Recent Caws ===');
  const caws = await prisma.caw.findMany({
    where: { userId: 1 },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      id: true,
      userId: true,
      cawonce: true,
      content: true,
      action: true,
      createdAt: true
    }
  });

  for (const caw of caws) {
    console.log(`\nCaw ID: ${caw.id}`);
    console.log(`UserId: ${caw.userId}, Cawonce: ${caw.cawonce}`);
    console.log(`Content: ${caw.content?.substring(0, 50)}...`);
    console.log(`Action: ${caw.action}`);
    console.log(`CreatedAt: ${caw.createdAt}`);
  }

  await prisma.$disconnect();
}

debug().catch(console.error);
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function cleanStuckTransaction() {
  console.log('=== Cleaning Stuck Transaction ===');

  // Find the stuck transaction with ID 21
  const stuckTx = await prisma.txQueue.findFirst({
    where: {
      id: 21,
      status: 'pending'
    }
  });

  if (stuckTx) {
    console.log('Found stuck transaction:');
    console.log('ID:', stuckTx.id);
    console.log('Status:', stuckTx.status);
    console.log('Cawonce:', stuckTx.payload.data.cawonce);
    console.log('Created:', stuckTx.createdAt);

    // Mark it as failed since it has invalid cawonce
    await prisma.txQueue.update({
      where: { id: 21 },
      data: {
        status: 'failed',
        updatedAt: new Date()
      }
    });

    console.log('\n✅ Marked transaction 21 as failed');
  } else {
    console.log('Transaction 21 not found or already cleaned up');
  }

  // Also clean any other pending transactions with cawonce=0
  const invalidTxs = await prisma.$queryRaw`
    SELECT * FROM "TxQueue"
    WHERE status = 'pending'
    AND (payload->'data'->>'cawonce')::int = 0
  `;

  if (invalidTxs.length > 0) {
    console.log(`\nFound ${invalidTxs.length} other transactions with invalid cawonce=0`);

    for (const tx of invalidTxs) {
      await prisma.txQueue.update({
        where: { id: tx.id },
        data: {
          status: 'failed',
          updatedAt: new Date()
        }
      });
      console.log(`Marked transaction ${tx.id} as failed`);
    }
  }

  await prisma.$disconnect();
}

cleanStuckTransaction().catch(console.error);
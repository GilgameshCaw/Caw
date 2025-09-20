const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkTxDetails() {
  const pendingTx = await prisma.txQueue.findFirst({
    where: { status: 'pending' },
    orderBy: { createdAt: 'desc' }
  });

  if (pendingTx) {
    console.log('Pending Transaction Details:');
    console.log('ID:', pendingTx.id);
    console.log('Sender:', pendingTx.senderId);
    console.log('Status:', pendingTx.status);
    console.log('Created:', pendingTx.createdAt);
    console.log('Payload:', JSON.stringify(pendingTx.payload.data, null, 2));

    // Check if this cawonce already exists
    const existingAction = await prisma.action.findFirst({
      where: {
        senderId: pendingTx.senderId,
        cawonce: pendingTx.payload.data.cawonce
      }
    });

    if (existingAction) {
      console.log('\n⚠️  ACTION ALREADY EXISTS with this cawonce!');
      console.log('Existing action:', existingAction);
      console.log('\nThis transaction will fail with "Cawonce already used"');
    } else {
      console.log('\n✓ No existing action with this cawonce');
    }

    // Get the user's latest cawonce
    const latestAction = await prisma.action.findFirst({
      where: { senderId: pendingTx.senderId },
      orderBy: { cawonce: 'desc' }
    });

    console.log('\nUser\'s latest cawonce:', latestAction?.cawonce || 'none');
    console.log('Transaction trying to use cawonce:', pendingTx.payload.data.cawonce);

    if (latestAction && pendingTx.payload.data.cawonce <= latestAction.cawonce) {
      console.log('\n❌ This cawonce is too old! Should be:', latestAction.cawonce + 1);
    }
  }

  await prisma.$disconnect();
}

checkTxDetails().catch(console.error);
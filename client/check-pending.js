const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkPending() {
  console.log('=== Checking Pending Likes ===');
  const pendingLikes = await prisma.like.findMany({
    where: { pending: true },
    include: { user: true, caw: true }
  });

  console.log(`Found ${pendingLikes.length} pending likes:`);
  pendingLikes.forEach(like => {
    console.log(`- User ${like.userId} liked Caw ${like.cawId} (pending: ${like.pending})`);
  });

  console.log('\n=== Checking Pending Transactions ===');
  const pendingTxs = await prisma.txQueue.findMany({
    where: { status: 'pending' }
  });

  console.log(`Found ${pendingTxs.length} pending transactions:`);
  pendingTxs.forEach(tx => {
    console.log(`- TxQueue ID ${tx.id}: Sender ${tx.senderId}, Status: ${tx.status}`);
    console.log(`  Created: ${tx.createdAt}`);
  });

  // Check if validator is picking them up
  console.log('\n=== Checking Latest Actions ===');
  const latestActions = await prisma.action.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5
  });

  console.log(`Latest ${latestActions.length} actions:`);
  latestActions.forEach(action => {
    console.log(`- Action: ${action.actionType}, Sender ${action.senderId}, Cawonce ${action.cawonce}`);
  });

  await prisma.$disconnect();
}

checkPending().catch(console.error);
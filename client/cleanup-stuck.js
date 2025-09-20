const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function cleanupStuck() {
  console.log('=== Cleaning up stuck transactions and likes ===');

  // Delete the stuck transaction with ID 18
  try {
    const deleted = await prisma.txQueue.delete({
      where: { id: 18 }
    });
    console.log('Deleted stuck transaction:', deleted);
  } catch (err) {
    console.log('Transaction might already be deleted or not exist:', err.message);
  }

  // Clean up the pending like for user 1 on caw 125
  try {
    const deletedLike = await prisma.like.delete({
      where: {
        userId_cawId: {
          userId: 1,
          cawId: 125
        }
      }
    });
    console.log('Deleted pending like:', deletedLike);

    // Also decrement the like count on the caw
    await prisma.caw.update({
      where: { id: 125 },
      data: {
        likeCount: {
          decrement: 1
        }
      }
    });
    console.log('Decremented like count on caw 125');
  } catch (err) {
    console.log('Like might already be deleted:', err.message);
  }

  await prisma.$disconnect();
}

cleanupStuck().catch(console.error);
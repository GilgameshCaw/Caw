const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function fixPendingCaws() {
  try {
    // Update caw 153 (userId: 1, cawonce: 26) to SUCCESS since TxQueue shows it's done
    const result = await prisma.caw.update({
      where: {
        id: 153
      },
      data: {
        status: 'SUCCESS'
      }
    });
    console.log('Updated caw 153 to SUCCESS:', result);

    // Mark caw 151 (userId: 1, cawonce: 25) as FAILED since TxQueue shows it failed
    const result2 = await prisma.caw.update({
      where: {
        id: 151
      },
      data: {
        status: 'FAILED'
      }
    });
    console.log('Updated caw 151 to FAILED:', result2);

  } catch (error) {
    console.error('Error fixing pending caws:', error);
  } finally {
    await prisma.$disconnect();
  }
}

fixPendingCaws();
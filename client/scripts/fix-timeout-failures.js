const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function fixTimeoutFailures() {
  try {
    // Find all txQueue entries that failed due to timeout
    const timeoutFailures = await prisma.txQueue.findMany({
      where: {
        status: 'failed',
        reason: {
          contains: 'TIMEOUT'
        }
      }
    });

    console.log(`Found ${timeoutFailures.length} entries failed due to timeout`);

    if (timeoutFailures.length > 0) {
      // Reset them to pending so they can be retried
      const result = await prisma.txQueue.updateMany({
        where: {
          status: 'failed',
          reason: {
            contains: 'TIMEOUT'
          }
        },
        data: {
          status: 'pending',
          reason: null
        }
      });

      console.log(`Reset ${result.count} entries to pending status`);
    }

    // Also fix any caws that were marked as FAILED due to timeout
    const failedCaws = await prisma.caw.findMany({
      where: {
        status: 'FAILED'
      },
      select: {
        id: true,
        userId: true,
        cawonce: true,
        content: true
      }
    });

    console.log(`\nChecking ${failedCaws.length} failed caws...`);

    let cawsFixed = 0;
    for (const caw of failedCaws) {
      // Check if there's a corresponding txQueue entry that was timeout
      const txQueueEntry = await prisma.txQueue.findFirst({
        where: {
          payload: {
            path: ['data', 'senderId'],
            equals: caw.userId
          },
          AND: {
            payload: {
              path: ['data', 'cawonce'],
              equals: caw.cawonce
            }
          }
        }
      });

      if (txQueueEntry && (txQueueEntry.status === 'pending' ||
          (txQueueEntry.reason && txQueueEntry.reason.includes('TIMEOUT')))) {
        // Reset caw to PENDING
        await prisma.caw.update({
          where: { id: caw.id },
          data: { status: 'PENDING' }
        });
        cawsFixed++;
        console.log(`Reset caw ${caw.id} (user ${caw.userId}, cawonce ${caw.cawonce}) to PENDING`);
      }
    }

    console.log(`\nFixed ${cawsFixed} caws that were incorrectly marked as FAILED due to timeouts`);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

fixTimeoutFailures();
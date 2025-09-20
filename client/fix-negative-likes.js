const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function fixNegativeLikes() {
  console.log('=== Fixing Caws with Negative Like Counts ===');

  // Find caws with negative like counts
  const negativeCaws = await prisma.caw.findMany({
    where: {
      likeCount: {
        lt: 0
      }
    }
  });

  console.log(`Found ${negativeCaws.length} caws with negative like counts`);

  for (const caw of negativeCaws) {
    // Count actual likes for this caw
    const actualLikeCount = await prisma.like.count({
      where: {
        cawId: caw.id,
        action: 'LIKE',
        pending: false
      }
    });

    console.log(`Caw ${caw.id}: Current count = ${caw.likeCount}, Actual likes = ${actualLikeCount}`);

    // Update to correct count
    await prisma.caw.update({
      where: { id: caw.id },
      data: { likeCount: actualLikeCount }
    });

    console.log(`Fixed caw ${caw.id}: Set like count to ${actualLikeCount}`);
  }

  // Also check for any caws with incorrect counts
  console.log('\n=== Checking for Incorrect Like Counts ===');

  const allCaws = await prisma.caw.findMany({
    select: {
      id: true,
      likeCount: true,
      _count: {
        select: {
          likes: {
            where: {
              action: 'LIKE',
              pending: false
            }
          }
        }
      }
    }
  });

  let mismatchCount = 0;
  for (const caw of allCaws) {
    // Count actual non-pending likes
    const actualCount = await prisma.like.count({
      where: {
        cawId: caw.id,
        action: 'LIKE',
        pending: false
      }
    });

    if (caw.likeCount !== actualCount) {
      mismatchCount++;
      console.log(`Mismatch on Caw ${caw.id}: DB says ${caw.likeCount}, actual is ${actualCount}`);

      await prisma.caw.update({
        where: { id: caw.id },
        data: { likeCount: actualCount }
      });

      console.log(`Fixed caw ${caw.id}`);
    }
  }

  console.log(`\nFixed ${mismatchCount} mismatched like counts`);

  await prisma.$disconnect();
}

fixNegativeLikes().catch(console.error);
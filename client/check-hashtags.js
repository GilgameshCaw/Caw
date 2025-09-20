const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkHashtags() {
  console.log('=== Checking Hashtags in Database ===');

  const hashtags = await prisma.hashtag.findMany({
    orderBy: { usageCount: 'desc' },
    take: 10
  });

  console.log(`\nFound ${hashtags.length} hashtags:`);
  hashtags.forEach((tag, index) => {
    console.log(`#${index + 1}: #${tag.name} - ${tag.usageCount} caws`);
  });

  await prisma.$disconnect();
}

checkHashtags().catch(console.error);
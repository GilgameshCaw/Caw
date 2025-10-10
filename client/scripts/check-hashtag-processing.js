const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/caw_dev'
});

async function checkHashtagProcessing() {
  try {
    // Check recent blockchain events
    const events = await prisma.blockchainEvent.findMany({
      where: {
        eventName: 'Action',
        args: { contains: '"senderId":1' }
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        eventName: true,
        args: true,
        processed: true,
        createdAt: true
      }
    });

    console.log('Recent Action events for user 1:');
    events.forEach(e => {
      const args = JSON.parse(e.args);
      const text = args.text || '';
      console.log(`Event ${e.id}: processed=${e.processed}, cawonce=${args.cawonce}, text='${text.substring(0, 50)}'`);
    });

    // Check caws and their hashtags
    const cawsWithHashtags = await prisma.caw.findMany({
      where: {
        userId: 1,
        content: { contains: '#' }
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: {
        hashtags: {
          include: {
            hashtag: true
          }
        }
      }
    });

    console.log('\nCaws with hashtags:');
    cawsWithHashtags.forEach(c => {
      const hashtags = c.hashtags.map(h => h.hashtag.name);
      console.log(`Caw ${c.id} (cawonce ${c.cawonce}): "${c.content.substring(0, 50)}" => hashtags: [${hashtags.join(', ')}]`);
    });

    // Check hashtag table
    const allHashtags = await prisma.hashtag.findMany({
      orderBy: { usageCount: 'desc' }
    });

    console.log('\nAll hashtags in database:');
    allHashtags.forEach(h => {
      console.log(`  ${h.name}: ${h.usageCount} uses`);
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkHashtagProcessing();
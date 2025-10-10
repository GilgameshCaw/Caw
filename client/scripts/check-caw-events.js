const { PrismaClient } = require('@prisma/client');

async function checkCawEvents() {
  const prisma = new PrismaClient();

  try {
    // Check caws with hashtags
    const cawsWithHashtags = await prisma.caw.findMany({
      where: {
        content: { contains: '#' }
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        userId: true,
        cawonce: true,
        content: true,
        status: true,
        createdAt: true
      }
    });

    console.log('Recent caws with hashtags:');
    cawsWithHashtags.forEach(c => {
      console.log(`\nCaw ${c.id}: userId=${c.userId}, cawonce=${c.cawonce}, status=${c.status}`);
      console.log(`  Content: "${c.content}"`);
    });

    // Check if these caws have blockchain events
    console.log('\n\nChecking for corresponding blockchain events...');

    for (const caw of cawsWithHashtags) {
      const event = await prisma.blockchainEvent.findFirst({
        where: {
          eventName: 'Action',
          args: {
            contains: `"senderId":${caw.userId}`
          },
          AND: {
            args: {
              contains: `"cawonce":${caw.cawonce}`
            }
          }
        },
        select: {
          id: true,
          processed: true,
          createdAt: true,
          args: true
        }
      });

      if (event) {
        const args = JSON.parse(event.args);
        console.log(`\n  Event ${event.id} for caw ${caw.id}: processed=${event.processed}`);
        console.log(`    Text from event: "${args.text?.substring(0, 50)}"`);
      } else {
        console.log(`\n  NO EVENT FOUND for caw ${caw.id} (userId=${caw.userId}, cawonce=${caw.cawonce})`);
      }
    }

    // Check if ActionProcessor has created actions
    console.log('\n\nChecking for actions in database...');
    const actions = await prisma.action.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        rawEventId: true,
        createdAt: true
      }
    });

    console.log(`Found ${actions.length} actions in database`);
    if (actions.length > 0) {
      console.log('Recent actions:');
      actions.forEach(a => {
        console.log(`  Action ${a.id}: rawEventId=${a.rawEventId}, created=${a.createdAt}`);
      });
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkCawEvents();
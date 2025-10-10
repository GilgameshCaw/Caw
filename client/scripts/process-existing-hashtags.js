const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Extract hashtags from text content (copied from hashtags.ts)
 */
function extractHashtags(content) {
  const hashtagRegex = /[#$]([a-zA-Z0-9_\u00C0-\u017F\u1E00-\u1EFF\u0100-\u024F\u1EA0-\u1EF9]+)/g;
  const matches = content.match(hashtagRegex);

  if (!matches) return [];

  return matches
    .map(tag => tag.slice(1).toLowerCase())
    .filter((tag, index, array) => array.indexOf(tag) === index)
    .filter(tag => tag.length > 0 && tag.length <= 100);
}

/**
 * Process hashtags for a caw
 */
async function processHashtagsForCaw(cawId, content) {
  const hashtags = extractHashtags(content);

  if (hashtags.length === 0) {
    return;
  }

  // Process each hashtag
  for (const hashtagName of hashtags) {
    try {
      // Upsert hashtag
      const hashtag = await prisma.hashtag.upsert({
        where: { name: hashtagName },
        create: {
          name: hashtagName,
          usageCount: 1,
        },
        update: {
          usageCount: {
            increment: 1
          },
          updatedAt: new Date()
        }
      });

      // Create caw-hashtag association if it doesn't exist
      await prisma.cawHashtag.upsert({
        where: {
          cawId_hashtagId: {
            cawId: cawId,
            hashtagId: hashtag.id
          }
        },
        create: {
          cawId: cawId,
          hashtagId: hashtag.id
        },
        update: {}
      });
    } catch (error) {
      console.error(`Error processing hashtag "${hashtagName}" for caw ${cawId}:`, error);
    }
  }
}

async function processExistingHashtags() {
  try {
    // Get all caws with hashtags that haven't been processed
    const cawsWithHashtags = await prisma.caw.findMany({
      where: {
        content: { contains: '#' }
      },
      orderBy: { createdAt: 'desc' },
      include: {
        hashtags: true
      }
    });

    console.log(`Found ${cawsWithHashtags.length} caws with hashtags`);

    let processed = 0;
    let skipped = 0;

    for (const caw of cawsWithHashtags) {
      // Check if this caw already has hashtags processed
      if (caw.hashtags.length > 0) {
        console.log(`Caw ${caw.id} already has hashtags, skipping`);
        skipped++;
        continue;
      }

      console.log(`Processing hashtags for caw ${caw.id}: "${caw.content.substring(0, 50)}"...`);

      try {
        await processHashtagsForCaw(caw.id, caw.content);
        processed++;
        console.log(`✓ Processed hashtags for caw ${caw.id}`);
      } catch (error) {
        console.error(`✗ Failed to process hashtags for caw ${caw.id}:`, error);
      }
    }

    console.log(`\nSummary:`);
    console.log(`- Processed: ${processed} caws`);
    console.log(`- Skipped: ${skipped} caws (already had hashtags)`);

    // Show trending hashtags
    const hashtags = await prisma.hashtag.findMany({
      orderBy: { usageCount: 'desc' },
      take: 10
    });

    console.log(`\nTop trending hashtags:`);
    hashtags.forEach(h => {
      console.log(`  #${h.name}: ${h.usageCount} uses`);
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

processExistingHashtags();
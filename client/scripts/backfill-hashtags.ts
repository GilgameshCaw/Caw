// scripts/backfill-hashtags.ts
// This script processes all existing caws and extracts hashtags into the database

import { prisma } from '../src/prismaClient'
import { extractHashtags, processHashtagsForCaw } from '../src/tools/hashtags'

async function backfillHashtags() {
  console.log('Starting hashtag backfill...')

  try {
    // Get all caws
    const caws = await prisma.caw.findMany({
      select: {
        id: true,
        content: true,
      },
      orderBy: {
        id: 'asc'
      }
    })

    console.log(`Found ${caws.length} caws to process`)

    let processed = 0
    let withHashtags = 0
    let errors = 0

    // Process each caw
    for (const caw of caws) {
      try {
        const hashtags = extractHashtags(caw.content)

        if (hashtags.length > 0) {
          console.log(`Processing caw ${caw.id} with ${hashtags.length} hashtags: ${hashtags.join(', ')}`)
          await processHashtagsForCaw(caw.id, caw.content)
          withHashtags++
        }

        processed++

        // Log progress every 100 caws
        if (processed % 100 === 0) {
          console.log(`Progress: ${processed}/${caws.length} caws processed`)
        }
      } catch (error) {
        console.error(`Error processing caw ${caw.id}:`, error)
        errors++
      }
    }

    console.log('\n✅ Backfill complete!')
    console.log(`Total caws processed: ${processed}`)
    console.log(`Caws with hashtags: ${withHashtags}`)
    console.log(`Errors: ${errors}`)

    // Get final hashtag statistics
    const hashtagCount = await prisma.hashtag.count()
    const cawHashtagCount = await prisma.cawHashtag.count()
    const topHashtags = await prisma.hashtag.findMany({
      orderBy: { usageCount: 'desc' },
      take: 10,
      select: {
        name: true,
        usageCount: true
      }
    })

    console.log(`\nTotal unique hashtags: ${hashtagCount}`)
    console.log(`Total hashtag associations: ${cawHashtagCount}`)
    console.log('\nTop 10 hashtags:')
    topHashtags.forEach((tag, i) => {
      console.log(`  ${i + 1}. #${tag.name} (${tag.usageCount} uses)`)
    })

  } catch (error) {
    console.error('Fatal error during backfill:', error)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

// Run the script
backfillHashtags()
  .then(() => {
    console.log('\nScript completed successfully')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Script failed:', error)
    process.exit(1)
  })

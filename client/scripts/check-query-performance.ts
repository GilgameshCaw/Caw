import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient({
  log: [
    {
      emit: 'event',
      level: 'query',
    },
  ],
})

// Track query performance
const queryMetrics: Array<{ query: string; duration: number }> = []

// @ts-ignore
prisma.$on('query', (e: any) => {
  queryMetrics.push({
    query: e.query,
    duration: e.duration,
  })
})

async function testQueryPerformance() {
  console.log('=== Testing Query Performance with Status Filters ===\n')

  // Test 1: Main feed query
  console.log('1. Testing main feed query (status = SUCCESS)...')
  const start1 = Date.now()
  const mainFeedCaws = await prisma.caw.findMany({
    where: { status: 'SUCCESS' },
    orderBy: [
      { createdAt: 'desc' },
      { id: 'desc' }
    ],
    take: 20,
    include: {
      user: { select: { tokenId: true, username: true, image: true } }
    }
  })
  console.log(`   Found ${mainFeedCaws.length} caws in ${Date.now() - start1}ms\n`)

  // Test 2: Hashtag query with status filter
  console.log('2. Testing hashtag query with status filter...')
  const start2 = Date.now()
  const hashtagCaws = await prisma.cawHashtag.findMany({
    where: {
      hashtagId: 1, // Assuming hashtag with ID 1 exists
      caw: { status: 'SUCCESS' }
    },
    take: 20,
    include: {
      caw: {
        include: {
          user: { select: { tokenId: true, username: true } }
        }
      }
    }
  })
  console.log(`   Found ${hashtagCaws.length} hashtag caws in ${Date.now() - start2}ms\n`)

  // Test 3: Search query with status filter
  console.log('3. Testing search query with status filter...')
  const start3 = Date.now()
  const searchCaws = await prisma.caw.findMany({
    where: {
      content: { contains: 'test', mode: 'insensitive' },
      status: 'SUCCESS'
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: {
      user: { select: { tokenId: true, username: true } }
    }
  })
  console.log(`   Found ${searchCaws.length} search results in ${Date.now() - start3}ms\n`)

  // Test 4: Following feed query
  console.log('4. Testing following feed query...')
  const start4 = Date.now()
  const followingCaws = await prisma.caw.findMany({
    where: {
      OR: [
        { status: 'SUCCESS' },
        {
          status: { in: ['PENDING', 'FAILED'] },
          userId: 1 // Example user ID
        }
      ],
      userId: { in: [1, 2, 3] } // Example following IDs
    },
    orderBy: [
      { createdAt: 'desc' },
      { id: 'desc' }
    ],
    take: 20,
    include: {
      user: { select: { tokenId: true, username: true } }
    }
  })
  console.log(`   Found ${followingCaws.length} following caws in ${Date.now() - start4}ms\n`)

  // Test 5: Profile query with status filter
  console.log('5. Testing profile query with status filter...')
  const start5 = Date.now()
  const profileCaws = await prisma.caw.findMany({
    where: {
      userId: 1, // Example user ID
      OR: [
        { status: 'SUCCESS' },
        {
          status: { in: ['PENDING', 'FAILED'] },
          userId: 1
        }
      ]
    },
    orderBy: [
      { createdAt: 'desc' },
      { id: 'desc' }
    ],
    take: 20,
    include: {
      user: { select: { tokenId: true, username: true } }
    }
  })
  console.log(`   Found ${profileCaws.length} profile caws in ${Date.now() - start5}ms\n`)

  // Analyze slow queries
  console.log('=== Query Performance Analysis ===\n')
  const slowQueries = queryMetrics.filter(m => m.duration > 100)

  if (slowQueries.length > 0) {
    console.log('⚠️  Slow queries detected (>100ms):\n')
    slowQueries.forEach((q, i) => {
      console.log(`${i + 1}. Duration: ${q.duration}ms`)
      console.log(`   Query: ${q.query.substring(0, 100)}...`)
      console.log()
    })
  } else {
    console.log('✅ All queries performed well (under 100ms)\n')
  }

  // Show statistics
  const avgDuration = queryMetrics.reduce((sum, m) => sum + m.duration, 0) / queryMetrics.length
  const maxDuration = Math.max(...queryMetrics.map(m => m.duration))
  const minDuration = Math.min(...queryMetrics.map(m => m.duration))

  console.log('=== Performance Statistics ===')
  console.log(`Total queries executed: ${queryMetrics.length}`)
  console.log(`Average query duration: ${avgDuration.toFixed(2)}ms`)
  console.log(`Fastest query: ${minDuration}ms`)
  console.log(`Slowest query: ${maxDuration}ms`)

  await prisma.$disconnect()
}

testQueryPerformance().catch(console.error)
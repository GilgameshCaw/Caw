import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function check() {
  console.log('=== Checking Action 2970 ===')

  const action = await prisma.action.findUnique({
    where: { id: 2970 },
    include: {
      rawEvent: true
    }
  })

  if (!action) {
    console.log('Action 2970 not found!')
    await prisma.$disconnect()
    return
  }

  console.log('Action found:')
  console.log('  Type:', action.actionType)
  console.log('  SenderId:', action.senderId)
  console.log('  Data:', JSON.stringify(action.data, null, 2))

  // Check if corresponding caw exists
  if (action.actionType === 'CAW' || action.actionType === 0) {
    const cawonce = (action.data as any)?.cawonce
    console.log('  Cawonce from action:', cawonce)

    const caw = await prisma.caw.findFirst({
      where: {
        userId: action.senderId,
        cawonce: cawonce
      }
    })

    if (caw) {
      console.log('  ✅ Caw exists: ID', caw.id, 'Status:', caw.status)
    } else {
      console.log('  ❌ NO CAW FOUND for userId:', action.senderId, 'cawonce:', cawonce)

      // Check all caws for this user
      const userCaws = await prisma.caw.findMany({
        where: { userId: action.senderId },
        orderBy: { cawonce: 'desc' },
        take: 5
      })
      console.log('  Recent caws for this user:')
      userCaws.forEach(c => console.log(`    - Cawonce: ${c.cawonce}, ID: ${c.id}, Status: ${c.status}`))
    }

    // Check hashtags
    const hashtags = await prisma.hashtag.findMany({
      where: {
        caws: {
          some: {
            caw: {
              userId: action.senderId,
              cawonce: cawonce
            }
          }
        }
      }
    })

    if (hashtags.length > 0) {
      console.log('  Hashtags found:', hashtags.length)
      hashtags.forEach(h => console.log('    -', h.name))
    }
  }

  await prisma.$disconnect()
}

check().catch(console.error)
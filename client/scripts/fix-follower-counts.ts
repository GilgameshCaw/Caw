import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function fixFollowerCounts() {
  console.log('Recalculating follower and following counts...')
  
  const users = await prisma.user.findMany()
  
  for (const user of users) {
    // followerCount = number of people who follow this user
    // = number of Follow records where followingId = user.tokenId
    const followerCount = await prisma.follow.count({
      where: {
        followingId: user.tokenId,
        action: 'FOLLOW'
      }
    })
    
    // followingCount = number of people this user follows
    // = number of Follow records where followerId = user.tokenId
    const followingCount = await prisma.follow.count({
      where: {
        followerId: user.tokenId,
        action: 'FOLLOW'
      }
    })
    
    await prisma.user.update({
      where: { tokenId: user.tokenId },
      data: {
        followerCount,
        followingCount
      }
    })
    
    console.log(`User ${user.username}: ${followerCount} followers, ${followingCount} following`)
  }
  
  console.log('Done!')
  await prisma.$disconnect()
}

fixFollowerCounts()

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function createTestUser() {
  try {
    const user = await prisma.user.create({
      data: {
        tokenId: 4,
        address: '0xde7bb2b52f37db2232cde4f5541eea846a5791c8',
        username: 'test_user4',
        image: '',
        cawCount: 0,
        followerCount: 0,
        followingCount: 0,
        likeCount: 0,
      },
    });
    console.log('Created user:', user);
  } catch (error) {
    console.error('Error creating user:', error);
  } finally {
    await prisma.$disconnect();
  }
}

createTestUser();
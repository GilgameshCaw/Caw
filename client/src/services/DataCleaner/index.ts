import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/**
 * Clean up stale pending likes
 * - If a like has been pending for 5+ minutes, check if the action exists on-chain
 * - If action exists, mark as not pending
 * - If action doesn't exist and it's been > 30 minutes, delete the like
 */
async function cleanupPendingLikes() {
  console.log('[DataCleaner] Cleaning up stale pending likes...')

  try {
    // Find likes that have been pending for more than 5 minutes
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000)

    const stalePendingLikes = await prisma.like.findMany({
      where: {
        pending: true,
        createdAt: {
          lt: fiveMinutesAgo  // Check after just 5 minutes
        }
      },
      include: {
        user: true,
        caw: true
      }
    })

    console.log(`[DataCleaner] Found ${stalePendingLikes.length} stale pending likes`)

    for (const pendingLike of stalePendingLikes) {
      try {
        // Check if an action exists for this like
        // We need to check both LIKE and UNLIKE actions since the user might have toggled
        const action = await prisma.action.findFirst({
          where: {
            senderId: pendingLike.userId,
            actionType: {
              in: ['LIKE', 'UNLIKE']
            },
            data: {
              path: ['receiverId'],
              equals: pendingLike.caw.userId
            }
          },
          orderBy: {
            createdAt: 'desc'
          }
        })

        if (action) {
          // Action exists on-chain, mark like as confirmed
          console.log(`[DataCleaner] Confirming like for user ${pendingLike.userId} on caw ${pendingLike.cawId}`)

          await prisma.like.update({
            where: {
              userId_cawId: {
                userId: pendingLike.userId,
                cawId: pendingLike.cawId
              }
            },
            data: {
              pending: false,
              action: action.actionType
            }
          })
        } else if (pendingLike.createdAt < thirtyMinutesAgo) {
          // No action found after 30 minutes, delete the optimistic like
          console.log(`[DataCleaner] Removing failed like for user ${pendingLike.userId} on caw ${pendingLike.cawId}`)

          await prisma.like.delete({
            where: {
              userId_cawId: {
                userId: pendingLike.userId,
                cawId: pendingLike.cawId
              }
            }
          })

          // Recalculate the correct like count instead of blindly decrementing
          const actualLikeCount = await prisma.like.count({
            where: {
              cawId: pendingLike.cawId,
              action: 'LIKE',
              pending: false
            }
          })

          await prisma.caw.update({
            where: { id: pendingLike.cawId },
            data: {
              likeCount: actualLikeCount
            }
          })

          console.log(`[DataCleaner] Updated caw ${pendingLike.cawId} like count to ${actualLikeCount}`)
        } else {
          // Still waiting, log but don't delete yet
          console.log(`[DataCleaner] Like still pending (${Math.floor((Date.now() - pendingLike.createdAt.getTime()) / 60000)} minutes): user ${pendingLike.userId} on caw ${pendingLike.cawId}`)
        }
      } catch (err) {
        console.error(`[DataCleaner] Error processing pending like ${pendingLike.userId}-${pendingLike.cawId}:`, err)
      }
    }

    console.log('[DataCleaner] Pending likes cleanup completed')
  } catch (err) {
    console.error('[DataCleaner] Fatal error during cleanup:', err)
  }
}

/**
 * Main cleanup function that runs all data cleaning tasks
 */
async function runDataCleanup() {
  console.log('[DataCleaner] Running data cleanup tasks...')

  // Clean up pending likes
  await cleanupPendingLikes()

  // Future cleanup tasks can be added here

  console.log('[DataCleaner] All cleanup tasks completed')
}

/**
 * Start the background worker
 * Runs every 5 minutes to clean up stale data
 */
function startDataCleanerWorker() {
  console.log('[DataCleaner] Starting background worker...')

  // Run immediately on startup
  runDataCleanup()

  // Then run every 1 minute for more responsive cleanup
  setInterval(() => {
    runDataCleanup()
  }, 1 * 60 * 1000) // 1 minute
}

// Export for use as a service
export const dataCleanerService = {
  name: 'DataCleaner',

  validateConfig(cfg: unknown) {
    // No configuration needed for this service
    return []
  },

  start(cfg: unknown) {
    startDataCleanerWorker()

    return {
      started: Promise.resolve(),
      async stop() {
        // Clean up any resources if needed
        await prisma.$disconnect()
      },
      stats: async () => 'Running data cleanup every minute'
    }
  }
}
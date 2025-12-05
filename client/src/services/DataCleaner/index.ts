import { PrismaClient } from '@prisma/client'
import { dataCleanerLogger as logger } from '../../utils/dataCleanerLogger'

const prisma = new PrismaClient()

/**
 * Clean up stale pending likes
 * - If a like has been pending for 5+ minutes, check if the action exists on-chain
 * - If action exists, mark as not pending
 * - If action doesn't exist and it's been > 30 minutes, delete the like
 */
async function cleanupPendingLikes() {
  logger.log('Cleaning up stale pending likes...')

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

    logger.log(`Found ${stalePendingLikes.length} stale pending likes`)

    for (const pendingLike of stalePendingLikes) {
      try {
        // Check if an action exists for this like
        // We need to check both LIKE and UNLIKE actions since the user might have toggled
        // Match by senderId, receiverId, AND receiverCawonce
        const action = await prisma.action.findFirst({
          where: {
            senderId: pendingLike.userId,
            actionType: {
              in: ['LIKE', 'UNLIKE']
            },
            AND: [
              {
                data: {
                  path: ['receiverId'],
                  equals: pendingLike.caw.userId
                }
              },
              {
                data: {
                  path: ['receiverCawonce'],
                  equals: pendingLike.caw.cawonce
                }
              }
            ]
          },
          orderBy: {
            createdAt: 'desc'
          }
        })

        if (action) {
          // Action exists on-chain, mark like as confirmed
          logger.log(` Confirming like for user ${pendingLike.userId} on caw ${pendingLike.cawId} (cawonce: ${pendingLike.caw.cawonce})`)

          // Update the like and get the previous state
          const updatedLike = await prisma.like.update({
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

          // Increment like count only if the action is LIKE (not UNLIKE) AND the like was pending
          // This prevents double-incrementing if ActionProcessor already processed it
          if (action.actionType === 'LIKE' && pendingLike.pending) {
            await prisma.caw.update({
              where: { id: pendingLike.cawId },
              data: { likeCount: { increment: 1 } }
            })
            logger.log(` Incremented like count for caw ${pendingLike.cawId}`)
          }
        } else if (pendingLike.createdAt < thirtyMinutesAgo) {
          // No action found after 30 minutes, delete the optimistic like
          logger.log(` Removing failed like for user ${pendingLike.userId} on caw ${pendingLike.cawId}`)

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

          logger.log(` Updated caw ${pendingLike.cawId} like count to ${actualLikeCount}`)
        } else {
          // Still waiting, log but don't delete yet
          logger.log(` Like still pending (${Math.floor((Date.now() - pendingLike.createdAt.getTime()) / 60000)} minutes): user ${pendingLike.userId} on caw ${pendingLike.cawId} (userId: ${pendingLike.caw.userId}, cawonce: ${pendingLike.caw.cawonce})`)
        }
      } catch (err) {
        logger.error(` Error processing pending like ${pendingLike.userId}-${pendingLike.cawId}:`, err)
      }
    }

    logger.log('Pending likes cleanup completed')
  } catch (err) {
    logger.error('Fatal error during cleanup:', err)
  }
}

/**
 * Clean up failed txqueue records and update associated caws
 * - Find txqueue records that have been failed for 5+ minutes
 * - For CAW actions, mark the associated caw as FAILED
 * - For LIKE actions, remove the pending like
 */
async function cleanupFailedTxQueue() {
  logger.log('Cleaning up failed txqueue records...')

  try {
    // Find txqueue records that have been failed for more than 5 minutes
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000)

    const failedTxQueueRecords = await prisma.txQueue.findMany({
      where: {
        status: 'failed',
        updatedAt: {
          lt: fiveMinutesAgo
        }
      }
    })

    logger.log(` Found ${failedTxQueueRecords.length} failed txqueue records`)

    for (const txRecord of failedTxQueueRecords) {
      try {
        const payload = txRecord.payload as any
        const data = payload?.data

        if (!data) {
          logger.log(` No data in txqueue record ${txRecord.id}`)
          continue
        }

        // Handle different action types
        if (data.actionType === 0 || data.actionType === 'caw') {
          // Update the associated caw to FAILED status
          logger.log(` Marking caw as FAILED for user ${data.senderId}, cawonce ${data.cawonce}`)

          await prisma.caw.updateMany({
            where: {
              userId: data.senderId,
              cawonce: data.cawonce,
              status: 'PENDING' // Only update if still pending
            },
            data: {
              status: 'FAILED'
            }
          })
        } else if (data.actionType === 1 || data.actionType === 'like') {
          // Remove the pending like if it exists
          logger.log(` Removing failed pending like for user ${data.senderId}`)

          // First find the target caw
          const targetCaw = await prisma.caw.findFirst({
            where: {
              userId: data.receiverId,
              cawonce: data.receiverCawonce
            }
          })

          if (targetCaw) {
            await prisma.like.deleteMany({
              where: {
                userId: data.senderId,
                cawId: targetCaw.id,
                pending: true
              }
            })

            // Recalculate the correct like count
            const actualLikeCount = await prisma.like.count({
              where: {
                cawId: targetCaw.id,
                action: 'LIKE',
                pending: false
              }
            })

            await prisma.caw.update({
              where: { id: targetCaw.id },
              data: {
                likeCount: actualLikeCount
              }
            })

            logger.log(` Updated caw ${targetCaw.id} like count to ${actualLikeCount}`)
          }
        } else if (data.actionType === 'other' && data.text && data.text.startsWith('profile-update:')) {
          // Clear the pending profile update flag
          logger.log(` Clearing pending profile update for user ${data.senderId}`)

          await prisma.user.updateMany({
            where: {
              tokenId: data.senderId,
              profileUpdatePending: true
            },
            data: {
              profileUpdatePending: false
            }
          })
        }

        // Optional: Delete very old failed txqueue records (e.g., older than 7 days)
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        if (txRecord.updatedAt < sevenDaysAgo) {
          logger.log(` Deleting old failed txqueue record ${txRecord.id}`)
          await prisma.txQueue.delete({
            where: { id: txRecord.id }
          })
        }
      } catch (err) {
        logger.error(` Error processing failed txqueue record ${txRecord.id}:`, err)
      }
    }

    logger.log('Failed txqueue cleanup completed')
  } catch (err) {
    logger.error('Fatal error during failed txqueue cleanup:', err)
  }
}

/**
 * Main cleanup function that runs all data cleaning tasks
 */
async function runDataCleanup() {
  logger.log('Running data cleanup tasks...')

  // Clean up pending likes
  await cleanupPendingLikes()

  // Clean up failed txqueue records and update associated caws
  await cleanupFailedTxQueue()

  logger.log('All cleanup tasks completed')
}

/**
 * Start the background worker
 * Runs every 5 minutes to clean up stale data
 */
function startDataCleanerWorker() {
  const date = new Date().toISOString().split('T')[0]
  console.log(`[DataCleaner] Starting background worker... Logs will be written to logs/data-cleaner-${date}.log`)
  logger.log('Starting background worker...')

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
        logger.log('Stopping DataCleaner service...')
        logger.close()
        await prisma.$disconnect()
      },
      stats: async () => 'Running data cleanup every minute'
    }
  }
}
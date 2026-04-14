import { prisma } from '../../prismaClient'
import { scheduledPostLogger as logger } from '../../utils/scheduledPostLogger'
import { processHashtagsForCaw } from '../../tools/hashtags'

/**
 * Process a single scheduled post
 * Submits the signed action to the TxQueue and creates the optimistic pending caw
 */
async function processScheduledPost(scheduledPost: any): Promise<boolean> {
  logger.log(`Processing scheduled post ${scheduledPost.id} for user ${scheduledPost.userId}`)

  try {
    const signedAction = scheduledPost.signedAction as any

    if (!signedAction || !signedAction.signature) {
      logger.error(`Scheduled post ${scheduledPost.id} has no valid signedAction`)
      await prisma.scheduledCaw.update({
        where: { id: scheduledPost.id },
        data: { status: 'failed' }
      })
      return false
    }

    const { data, domain, types, signature } = signedAction

    // Validate required fields
    if (!data || !signature) {
      logger.error(`Scheduled post ${scheduledPost.id} missing required fields in signedAction`)
      await prisma.scheduledCaw.update({
        where: { id: scheduledPost.id },
        data: { status: 'failed' }
      })
      return false
    }

    // Validate and sanitize amounts field
    if (data.amounts && Array.isArray(data.amounts)) {
      data.amounts = data.amounts.map((amt: any) => {
        if (amt === null || amt === undefined || amt === '') {
          return '0'
        }
        const strAmt = String(amt)
        if (strAmt === 'NaN' || isNaN(Number(strAmt))) {
          logger.warn(`Invalid amount value in scheduled post ${scheduledPost.id}: ${amt}, defaulting to 0`)
          return '0'
        }
        return strAmt
      })
    } else {
      data.amounts = []
    }

    // Create optimistic pending caw (same logic as actions.ts)
    try {
      logger.log(`Creating optimistic pending caw for user ${data.senderId}, cawonce ${data.cawonce}`)

      // Ensure user exists
      const user = await prisma.user.findUnique({
        where: { tokenId: data.senderId }
      })

      if (!user) {
        // Create user if doesn't exist (id = tokenId)
        await prisma.user.create({
          data: { id: data.senderId, tokenId: data.senderId, username: `user_${data.senderId}` }
        })
      }

      // Extract image URLs if present
      const imageUrlRegex = /(https?:\/\/[^\s]+\/uploads\/images\/[^\s]+\.(jpg|jpeg|png|gif|webp))/gi
      const imageUrls = data.text?.match(imageUrlRegex) || []
      const videoUrlRegex = /video:(https?:\/\/[^\s]+\/uploads\/videos\/[^\s]+\.(mp4|webm|mov|avi|mkv|ogg|ogv))/gi
      const videoMatches = [...(data.text?.matchAll(videoUrlRegex) || [])]
      const videoUrls = videoMatches.map((match: RegExpMatchArray) => match[1])

      // Remove URLs from text content
      let textContent = data.text || ''
      imageUrls.forEach((url: string) => {
        textContent = textContent.replace(url, '').trim()
      })
      videoMatches.forEach((match: RegExpMatchArray) => {
        textContent = textContent.replace(match[0], '').trim()
      })
      textContent = textContent.replace(/\n{3,}/g, '\n\n').trim()

      // For replies, find the parent caw ID
      let originalCawId: number | undefined
      if (data.receiverId && data.receiverCawonce) {
        const parentCaw = await prisma.caw.findFirst({
          where: {
            userId: data.receiverId,
            cawonce: data.receiverCawonce
          }
        })
        if (parentCaw) {
          originalCawId = parentCaw.id
          logger.log(`Found parent caw ID ${originalCawId} for reply`)
        }
      }

      // Create the pending caw
      const caw = await prisma.caw.upsert({
        where: {
          userId_cawonce: {
            userId: data.senderId,
            cawonce: data.cawonce
          }
        },
        update: {
          status: 'PENDING',
          originalCawId: originalCawId || null,
          updatedAt: new Date()
        },
        create: {
          userId: data.senderId,
          cawonce: data.cawonce,
          content: textContent,
          action: 'CAW',
          status: 'PENDING',
          originalCawId: originalCawId || null,
          imageData: imageUrls.length > 0 ? `urls:${imageUrls.join('|||')}` : scheduledPost.imageData || null,
          hasImage: imageUrls.length > 0 || scheduledPost.hasImage,
          videoData: videoUrls.length > 0 ? videoUrls.join('|||') : null,
          hasVideo: videoUrls.length > 0
        }
      })

      logger.log(`Created pending caw: ID=${caw.id}, userId=${caw.userId}, cawonce=${caw.cawonce}`)

      // Process hashtags
      try {
        await processHashtagsForCaw(caw.id, textContent)
        logger.log(`Processed hashtags for caw ${caw.id}`)
      } catch (err) {
        logger.error(`Failed to process hashtags for caw ${caw.id}`, err)
      }

      // Create the transaction queue entry
      const txQueueEntry = await prisma.txQueue.create({
        data: {
          senderId: data.senderId,
          payload: { data, domain, types },
          signedTx: signature
        }
      })

      logger.log(`Created TxQueue entry ${txQueueEntry.id} for scheduled post ${scheduledPost.id}`)

      // Update scheduled post status to published with the caw ID
      await prisma.scheduledCaw.update({
        where: { id: scheduledPost.id },
        data: {
          status: 'published',
          publishedId: caw.id
        }
      })

      logger.log(`Scheduled post ${scheduledPost.id} successfully published as caw ${caw.id}`)
      return true
    } catch (cawErr) {
      logger.error(`Failed to create caw for scheduled post ${scheduledPost.id}`, cawErr)
      await prisma.scheduledCaw.update({
        where: { id: scheduledPost.id },
        data: { status: 'failed' }
      })
      return false
    }
  } catch (err) {
    logger.error(`Error processing scheduled post ${scheduledPost.id}`, err)
    await prisma.scheduledCaw.update({
      where: { id: scheduledPost.id },
      data: { status: 'failed' }
    })
    return false
  }
}

/**
 * Find and process all due scheduled posts
 */
async function processDueScheduledPosts() {
  logger.log('Checking for due scheduled posts...')

  try {
    const now = new Date()

    // Find all pending scheduled posts where scheduledAt <= now
    const dueScheduledPosts = await prisma.scheduledCaw.findMany({
      where: {
        status: 'pending',
        scheduledAt: {
          lte: now
        }
      },
      orderBy: { scheduledAt: 'asc' }
    })

    if (dueScheduledPosts.length === 0) {
      logger.log('No due scheduled posts found')
      return
    }

    logger.log(`Found ${dueScheduledPosts.length} due scheduled posts to process`)

    let successCount = 0
    let failCount = 0

    for (const scheduledPost of dueScheduledPosts) {
      const success = await processScheduledPost(scheduledPost)
      if (success) {
        successCount++
      } else {
        failCount++
      }
    }

    logger.log(`Processed ${dueScheduledPosts.length} scheduled posts: ${successCount} succeeded, ${failCount} failed`)
  } catch (err) {
    logger.error('Fatal error during scheduled post processing', err)
  }
}

/**
 * Start the background worker
 * Runs every minute to check for due scheduled posts
 */
function startScheduledPostWorker(heartbeat?: () => void) {
  const date = new Date().toISOString().split('T')[0]
  console.log(`[ScheduledPostProcessor] Starting background worker... Logs will be written to logs/scheduled-posts-${date}.log`)
  logger.log('Starting background worker...')

  const runAndBeat = async () => {
    try {
      await processDueScheduledPosts()
    } finally {
      heartbeat?.()
    }
  }

  // Run immediately on startup
  runAndBeat()

  // Then run every minute
  setInterval(runAndBeat, 60 * 1000) // 1 minute
}

// Export for use as a service
export const scheduledPostProcessorService = {
  name: 'ScheduledPostProcessor',

  validateConfig(cfg: unknown) {
    // No configuration needed for this service
    return []
  },

  start(_cfg: unknown, ctx: import('../../Service').HeartbeatContext) {
    ctx.declareLoop('scheduled-posts', 5 * 60_000) // 5× 1-minute interval
    startScheduledPostWorker(() => ctx.heartbeat('scheduled-posts'))

    return {
      started: Promise.resolve(),
      async stop() {
        logger.log('Stopping ScheduledPostProcessor service...')
        logger.close()
        await prisma.$disconnect()
      },
      stats: async () => {
        const pendingCount = await prisma.scheduledCaw.count({ where: { status: 'pending' } })
        const publishedToday = await prisma.scheduledCaw.count({
          where: {
            status: 'published',
            updatedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) }
          }
        })
        return `Pending: ${pendingCount}, Published today: ${publishedToday}`
      }
    }
  }
}

import { PrismaClient } from '@prisma/client'
import { JsonRpcProvider, WebSocketProvider, Contract } from 'ethers'
import { dataCleanerLogger as logger } from '../../utils/dataCleanerLogger'
import { markTxQueueFailed } from '../../utils/txQueueFailure'
import { cawNameL2Abi } from '../../abi/generated'
import { CAW_NAMES_L2_ADDRESS } from '../../abi/addresses'

const prisma = new PrismaClient()

// Lazy-initialized L2 read provider for the pending-mint-deposit watcher.
// Reused across ticks so we don't churn sockets.
let _l2Provider: JsonRpcProvider | WebSocketProvider | null = null
let _cawNameL2: Contract | null = null

function getCawNameL2(): Contract {
  if (_cawNameL2) return _cawNameL2
  const rpcUrl = process.env.L2_RPC_URL_HTTP || process.env.L2_RPC_URL
  if (!rpcUrl) throw new Error('[DataCleaner] L2 RPC not configured')
  _l2Provider = rpcUrl.startsWith('wss://') || rpcUrl.startsWith('ws://')
    ? new WebSocketProvider(rpcUrl)
    : new JsonRpcProvider(rpcUrl)
  _cawNameL2 = new Contract(CAW_NAMES_L2_ADDRESS, cawNameL2Abi as any, _l2Provider)
  return _cawNameL2
}

const CAW_CLIENT_ID = Number(process.env.CLIENT_ID || 1)

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
 * Clean up stale pending tips
 * - If a tip has been pending for 5+ minutes, check if the action exists on-chain
 * - If action exists, mark as not pending
 * - If action doesn't exist and it's been > 30 minutes, delete the tip
 */
async function cleanupPendingTips() {
  logger.log('Cleaning up stale pending tips...')

  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000)

    const stalePendingTips = await prisma.tip.findMany({
      where: {
        pending: true,
        createdAt: {
          lt: fiveMinutesAgo
        }
      }
    })

    logger.log(`Found ${stalePendingTips.length} stale pending tips`)

    for (const pendingTip of stalePendingTips) {
      try {
        // Check if an OTHER action exists for this tip (match by senderId and cawonce)
        const action = await prisma.action.findFirst({
          where: {
            senderId: pendingTip.senderId,
            actionType: 'OTHER',
            cawonce: pendingTip.cawonce
          },
          orderBy: {
            createdAt: 'desc'
          }
        })

        if (action) {
          // Action exists on-chain, mark tip as confirmed
          logger.log(` Confirming tip from user ${pendingTip.senderId} to ${pendingTip.recipientId} (cawonce: ${pendingTip.cawonce})`)

          await prisma.tip.update({
            where: { id: pendingTip.id },
            data: { pending: false }
          })
        } else {
          // No Action record — check if txQueue completed (ActionProcessor may have missed the event)
          const completedTx = await prisma.txQueue.findFirst({
            where: {
              senderId: pendingTip.senderId,
              status: 'done',
              payload: { path: ['data', 'cawonce'], equals: pendingTip.cawonce }
            }
          })

          if (completedTx) {
            logger.log(` TxQueue confirms tip (event missed): user ${pendingTip.senderId} to ${pendingTip.recipientId}`)
            await prisma.tip.update({
              where: { id: pendingTip.id },
              data: { pending: false }
            })
          } else if (pendingTip.createdAt < thirtyMinutesAgo) {
            // No action and no completed tx after 30 minutes, delete the optimistic tip
            logger.log(` Removing failed tip from user ${pendingTip.senderId} to ${pendingTip.recipientId}`)

            await prisma.tip.delete({
              where: { id: pendingTip.id }
            })
          } else {
            logger.log(` Tip still pending (${Math.floor((Date.now() - pendingTip.createdAt.getTime()) / 60000)} minutes): user ${pendingTip.senderId} to ${pendingTip.recipientId}`)
          }
        }
      } catch (err) {
        logger.error(` Error processing pending tip ${pendingTip.id}:`, err)
      }
    }

    logger.log('Pending tips cleanup completed')
  } catch (err) {
    logger.error('Fatal error during tip cleanup:', err)
  }
}

/**
 * Clean up stale pending replies
 * - If a reply has been pending for 5+ minutes, check if the reply caw was confirmed
 * - If the reply caw is SUCCESS, mark reply as not pending
 * - If the reply caw is FAILED or missing after 30 minutes, delete the reply
 */
async function cleanupPendingReplies() {
  logger.log('Cleaning up stale pending replies...')

  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000)

    const stalePendingReplies = await prisma.reply.findMany({
      where: {
        pending: true,
        createdAt: {
          lt: fiveMinutesAgo
        }
      },
      include: {
        replyCaw: true
      }
    })

    logger.log(`Found ${stalePendingReplies.length} stale pending replies`)

    for (const pendingReply of stalePendingReplies) {
      try {
        if (pendingReply.replyCaw.status === 'SUCCESS') {
          // The reply caw was confirmed on-chain, mark reply as not pending
          logger.log(` Confirming reply ${pendingReply.id} (replyCaw ${pendingReply.replyCawId} is SUCCESS)`)

          await prisma.reply.update({
            where: { id: pendingReply.id },
            data: { pending: false }
          })
        } else if (pendingReply.replyCaw.status === 'FAILED') {
          // The reply caw failed, delete the reply record
          logger.log(` Removing failed reply ${pendingReply.id} (replyCaw ${pendingReply.replyCawId} is FAILED)`)

          await prisma.reply.delete({
            where: { id: pendingReply.id }
          })

          // Recalculate comment count on the parent caw
          const actualReplyCount = await prisma.reply.count({
            where: {
              cawId: pendingReply.cawId,
              pending: false
            }
          })

          await prisma.caw.update({
            where: { id: pendingReply.cawId },
            data: { commentCount: actualReplyCount }
          })

          logger.log(` Updated caw ${pendingReply.cawId} comment count to ${actualReplyCount}`)
        } else if (pendingReply.createdAt < thirtyMinutesAgo) {
          // Reply caw is still PENDING after 30 minutes — something is stuck
          logger.log(` Removing stale reply ${pendingReply.id} (pending > 30 min, replyCaw status: ${pendingReply.replyCaw.status})`)

          // Mark the reply caw as FAILED too
          await prisma.caw.updateMany({
            where: {
              id: pendingReply.replyCawId,
              status: 'PENDING'
            },
            data: { status: 'FAILED' }
          })

          await prisma.reply.delete({
            where: { id: pendingReply.id }
          })

          const actualReplyCount = await prisma.reply.count({
            where: {
              cawId: pendingReply.cawId,
              pending: false
            }
          })

          await prisma.caw.update({
            where: { id: pendingReply.cawId },
            data: { commentCount: actualReplyCount }
          })

          logger.log(` Updated caw ${pendingReply.cawId} comment count to ${actualReplyCount}`)
        } else {
          logger.log(` Reply still pending (${Math.floor((Date.now() - pendingReply.createdAt.getTime()) / 60000)} minutes): reply ${pendingReply.id} on caw ${pendingReply.cawId}`)
        }
      } catch (err) {
        logger.error(` Error processing pending reply ${pendingReply.id}:`, err)
      }
    }

    logger.log('Pending replies cleanup completed')
  } catch (err) {
    logger.error('Fatal error during reply cleanup:', err)
  }
}

/**
 * Clean up stale pending caws (posts)
 * - If a caw has been PENDING for 5+ minutes, check if the action exists on-chain
 * - If action exists, mark as SUCCESS
 * - If action doesn't exist and it's been > 30 minutes, mark as FAILED
 */
async function cleanupPendingCaws() {
  logger.log('Cleaning up stale pending caws...')

  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000)

    const stalePendingCaws = await prisma.caw.findMany({
      where: {
        status: 'PENDING',
        createdAt: {
          lt: fiveMinutesAgo
        }
      }
    })

    logger.log(`Found ${stalePendingCaws.length} stale pending caws`)

    for (const pendingCaw of stalePendingCaws) {
      try {
        // Check if an action exists for this caw (matched by senderId + cawonce)
        const action = await prisma.action.findFirst({
          where: {
            senderId: pendingCaw.userId,
            actionType: { in: ['CAW', 'RECAW'] },
            cawonce: pendingCaw.cawonce
          }
        })

        if (action) {
          // Action exists on-chain, mark caw as SUCCESS
          logger.log(` Confirming caw ${pendingCaw.id} for user ${pendingCaw.userId} (cawonce: ${pendingCaw.cawonce})`)

          await prisma.caw.update({
            where: { id: pendingCaw.id },
            data: { status: 'SUCCESS' }
          })
        } else {
          // Check if there's a completed txqueue entry for this caw
          const completedTx = await prisma.txQueue.findFirst({
            where: {
              senderId: pendingCaw.userId,
              status: 'done',
              payload: { path: ['data', 'cawonce'], equals: pendingCaw.cawonce }
            }
          })

          if (completedTx) {
            logger.log(` TxQueue confirms caw (event missed): ${pendingCaw.id} user ${pendingCaw.userId}`)
            await prisma.caw.update({
              where: { id: pendingCaw.id },
              data: { status: 'SUCCESS' }
            })
          } else if (pendingCaw.createdAt < thirtyMinutesAgo) {
            // No action found after 30 minutes, mark as FAILED
            logger.log(` Marking caw ${pendingCaw.id} as FAILED (pending > 30 min, user ${pendingCaw.userId}, cawonce: ${pendingCaw.cawonce})`)

            await prisma.caw.update({
              where: { id: pendingCaw.id },
              data: { status: 'FAILED' }
            })

            // If this was a recaw, decrement the parent's recawCount
            if (pendingCaw.action === 'RECAW' && pendingCaw.originalCawId) {
              try {
                const actualRecawCount = await prisma.caw.count({
                  where: {
                    originalCawId: pendingCaw.originalCawId,
                    action: 'RECAW',
                    status: 'SUCCESS'
                  }
                })
                await prisma.caw.update({
                  where: { id: pendingCaw.originalCawId },
                  data: { recawCount: actualRecawCount }
                })
                logger.log(` Updated parent caw ${pendingCaw.originalCawId} recawCount to ${actualRecawCount}`)
              } catch (err) {
                logger.error(` Failed to update recawCount for parent caw ${pendingCaw.originalCawId}:`, err)
              }
            }

            // Also clean up any reply records pointing to this caw as a reply
            const replyRecord = await prisma.reply.findFirst({
              where: { replyCawId: pendingCaw.id }
            })
            if (replyRecord) {
              await prisma.reply.delete({ where: { id: replyRecord.id } })

              const actualReplyCount = await prisma.reply.count({
                where: { cawId: replyRecord.cawId, pending: false }
              })
              await prisma.caw.update({
                where: { id: replyRecord.cawId },
                data: { commentCount: actualReplyCount }
              })
              logger.log(` Cleaned up reply record for failed caw, updated parent comment count`)
            }
          } else {
            logger.log(` Caw still pending (${Math.floor((Date.now() - pendingCaw.createdAt.getTime()) / 60000)} minutes): caw ${pendingCaw.id} user ${pendingCaw.userId}`)
          }
        }
      } catch (err) {
        logger.error(` Error processing pending caw ${pendingCaw.id}:`, err)
      }
    }

    logger.log('Pending caws cleanup completed')
  } catch (err) {
    logger.error('Fatal error during caw cleanup:', err)
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
        if (data.actionType === 0 || data.actionType === 'caw' || data.actionType === 3 || data.actionType === 'recaw') {
          // Update the associated caw/recaw to FAILED status
          logger.log(` Marking caw/recaw as FAILED for user ${data.senderId}, cawonce ${data.cawonce}`)

          // Find the pending caw before updating (to know if we need to decrement counts)
          const pendingCaw = await prisma.caw.findFirst({
            where: { userId: data.senderId, cawonce: data.cawonce, status: 'PENDING' }
          })

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

          // Decrement recawCount on parent if this was a pending recaw
          if (pendingCaw && pendingCaw.action === 'RECAW' && pendingCaw.originalCawId) {
            try {
              const actualRecawCount = await prisma.caw.count({
                where: { originalCawId: pendingCaw.originalCawId, action: 'RECAW', status: 'SUCCESS' }
              })
              await prisma.caw.update({
                where: { id: pendingCaw.originalCawId },
                data: { recawCount: actualRecawCount }
              })
              logger.log(` Updated parent caw ${pendingCaw.originalCawId} recawCount to ${actualRecawCount}`)
            } catch (err) {
              logger.error(` Failed to update recawCount:`, err)
            }
          }
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
        } else if (data.actionType === 4 || data.actionType === 'follow') {
          // Delete the pending follow record (only if still pending — a prior successful tx may have confirmed it)
          logger.log(` Removing failed pending follow for user ${data.senderId} -> ${data.receiverId}`)

          await prisma.follow.deleteMany({
            where: {
              followerId: data.senderId,
              followingId: data.receiverId,
              status: 'PENDING'
            }
          })
        } else if (data.actionType === 5 || data.actionType === 'unfollow') {
          // Unfollow failed — revert the follow back to SUCCESS (only if still pending)
          logger.log(` Reverting failed unfollow for user ${data.senderId} -> ${data.receiverId}`)

          await prisma.follow.updateMany({
            where: {
              followerId: data.senderId,
              followingId: data.receiverId,
              status: 'PENDING'
            },
            data: {
              status: 'SUCCESS',
              action: 'FOLLOW'
            }
          })
        } else if ((data.actionType === 7 || data.actionType === 'other') && data.text?.startsWith('tip:')) {
          // Remove the pending tip
          logger.log(` Removing failed pending tip for user ${data.senderId}`)

          await prisma.tip.deleteMany({
            where: {
              senderId: data.senderId,
              cawonce: data.cawonce,
              pending: true
            }
          })
        } else if (data.actionType === 'other' && data.text && (data.text.startsWith('profile-update:') || data.text.startsWith('p:'))) {
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
 * Clean up stale pending follows
 * - If a follow has been PENDING for 5+ minutes, check if the action exists on-chain
 * - If action exists, mark as SUCCESS
 * - If action doesn't exist and it's been > 30 minutes, delete the follow
 */
async function cleanupPendingFollows() {
  logger.log('Cleaning up stale pending follows...')

  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000)

    const stalePendingFollows = await prisma.follow.findMany({
      where: {
        status: 'PENDING',
        updatedAt: { lt: fiveMinutesAgo }
      }
    })

    logger.log(`Found ${stalePendingFollows.length} stale pending follows`)

    for (const pendingFollow of stalePendingFollows) {
      try {
        const fId = pendingFollow.followerId
        const tId = pendingFollow.followingId
        const uniqueWhere = { followerId_followingId: { followerId: fId, followingId: tId } }

        // 1. Check the Action table — the most recent FOLLOW/UNFOLLOW for this pair
        const action = await prisma.action.findFirst({
          where: {
            senderId: fId,
            actionType: { in: ['FOLLOW', 'UNFOLLOW'] },
            AND: [{ data: { path: ['receiverId'], equals: tId } }]
          },
          orderBy: { createdAt: 'desc' }
        })

        if (action) {
          // The most recent on-chain action is the source of truth
          if (action.actionType === 'UNFOLLOW') {
            logger.log(` Most recent action is UNFOLLOW — deleting follow: ${fId} -> ${tId}`)
            await prisma.follow.delete({ where: uniqueWhere })
          } else {
            logger.log(` Most recent action is FOLLOW — confirming: ${fId} -> ${tId}`)
            await prisma.follow.update({ where: uniqueWhere, data: { status: 'SUCCESS', action: 'FOLLOW' } })
          }
          continue
        }

        // 2. No Action record — check if the most recent txqueue for this pair completed
        //    (ActionProcessor may have missed the on-chain event)
        const completedTx = await prisma.txQueue.findFirst({
          where: {
            senderId: fId,
            status: 'done',
            payload: { path: ['data', 'receiverId'], equals: tId }
          },
          orderBy: { createdAt: 'desc' }
        })

        if (completedTx) {
          const txData = (completedTx.payload as any)?.data
          const isUnfollow = txData?.actionType === 5 || txData?.actionType === 'unfollow'

          if (isUnfollow) {
            logger.log(` TxQueue confirms unfollow (event missed): ${fId} -> ${tId}`)
            await prisma.follow.delete({ where: uniqueWhere })
          } else {
            logger.log(` TxQueue confirms follow (event missed): ${fId} -> ${tId}`)
            await prisma.follow.update({ where: uniqueWhere, data: { status: 'SUCCESS', action: 'FOLLOW' } })
          }
          continue
        }

        // 3. No Action, no completed TxQueue — wait or clean up
        if (pendingFollow.updatedAt < thirtyMinutesAgo) {
          logger.log(` No confirmation after 30 min — removing stale follow: ${fId} -> ${tId}`)
          await prisma.follow.delete({ where: uniqueWhere })
        } else {
          logger.log(` Follow still pending (${Math.floor((Date.now() - pendingFollow.updatedAt.getTime()) / 60000)} min): ${fId} -> ${tId}`)
        }
      } catch (err) {
        logger.error(` Error processing pending follow ${pendingFollow.followerId}->${pendingFollow.followingId}:`, err)
      }
    }

    logger.log('Pending follows cleanup completed')
  } catch (err) {
    logger.error('Fatal error during follow cleanup:', err)
  }
}

/**
 * Promote waiting_for_deposit TxQueue rows back to 'pending' once the sender's
 * L1 mint/deposit has actually landed on L2.
 *
 * Flow:
 *   1. Group waiting_for_deposit rows by senderId.
 *   2. For each unique sender, read authenticated[CLIENT_ID][tokenId] on L2.
 *   3. If authenticated == true → the L1→L2 bridge has delivered. Promote all
 *      that sender's waiting rows back to 'pending' and clear pendingDepositTxHash.
 *      The validator will then simulate them normally — if the user's L2 CAW
 *      balance covers the cost, they succeed; if not, they fail with a clear
 *      "insufficient balance" reason (the user asked to spend more than they
 *      actually deposited, which is their problem, not a race condition).
 *   4. Rows older than 20 min whose sender is still not authenticated get
 *      failed with a "deposit did not arrive" reason (L1 tx reverted, LZ
 *      delivery delayed, etc). The validator has its own 25-min safety-net
 *      sweep as a second line of defense.
 *
 * Cost per tick: one L2 RPC call per unique waiting sender. Typically 0-5 calls.
 */
async function cleanupPendingMintDeposits() {
  try {
    const waitingRows = await prisma.txQueue.findMany({
      where: { status: 'waiting_for_deposit' },
      select: { id: true, senderId: true, createdAt: true, pendingDepositTxHash: true, payload: true }
    })

    // Second responsibility: clear User.pendingDepositAmount display hints for
    // users with a recent lastStakedAt whose L2 auth has landed, even if they
    // have no waiting_for_deposit rows (e.g. they deposited but didn't queue
    // any actions). Without this sweep, ProfileChooser's "+X CAW pending"
    // badge would linger indefinitely, showing alongside the now-updated
    // staked balance — the "314M AND +314M pending" double-display bug.
    const usersWithPendingDisplay = await prisma.user.findMany({
      where: {
        lastStakedAt: { not: null },
        pendingDepositAmount: { not: null },
      },
      select: { tokenId: true }
    })

    if (waitingRows.length === 0 && usersWithPendingDisplay.length === 0) return

    logger.log(`[PendingMintDeposit] ${waitingRows.length} waiting rows, ${usersWithPendingDisplay.length} display-only, checking L2...`)

    // Group by sender to minimize RPC calls. Include display-only senders
    // (users with pendingDepositAmount set but no waiting rows) so we can
    // clear their display hints on the same pass.
    const bySender = new Map<number, typeof waitingRows>()
    for (const row of waitingRows) {
      const list = bySender.get(row.senderId) ?? []
      list.push(row)
      bySender.set(row.senderId, list)
    }
    for (const user of usersWithPendingDisplay) {
      if (!bySender.has(user.tokenId)) {
        bySender.set(user.tokenId, [])
      }
    }

    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000)
    let contract: Contract
    try {
      contract = getCawNameL2()
    } catch (err: any) {
      logger.error(`[PendingMintDeposit] Cannot get L2 contract, skipping pass: ${err.message}`)
      return
    }

    for (const [senderId, rows] of bySender) {
      try {
        // Read BOTH on-chain signals. Auth and balance can land at slightly
        // different times on L2 even for mintAndDeposit (LZ delivery order
        // isn't guaranteed within the same bundle), so promoting purely on
        // auth was causing a subtle bug: the validator would simulate a row
        // with auth=true but balance=0 and fail it with "Insufficient CAW
        // balance" — a transient condition that looked like a terminal
        // failure. Waiting for both signals eliminates that race.
        const [isAuthenticated, cawBalanceRaw]: [boolean, any] = await Promise.all([
          contract.authenticated(CAW_CLIENT_ID, senderId),
          contract.cawBalanceOf(senderId),
        ])
        const cawBalance = BigInt(cawBalanceRaw?.toString() ?? '0')

        // "Deposit has landed" means auth is true AND the token has a
        // non-zero L2 CAW balance. We don't compare against the specific
        // deposit amount here because multi-deposit scenarios make that
        // brittle — as long as there's SOME balance on L2, the validator
        // can simulate normally. If the user queued more than they can
        // afford, simulation will fail with a legitimate insufficient
        // balance error (not a race-condition one).
        if (isAuthenticated && cawBalance > 0n) {
          // Both signals present. Promote all waiting rows for this sender
          // so the validator can simulate them normally.
          const promoted = await prisma.txQueue.updateMany({
            where: {
              senderId,
              status: 'waiting_for_deposit'
            },
            data: {
              status: 'pending',
              pendingDepositTxHash: null,
              reason: null
            }
          })
          logger.log(`[PendingMintDeposit] Sender ${senderId}: L2 auth + balance confirmed (${cawBalance}) — promoted ${promoted.count} rows`)

          // Clear the User.lastStakedAt/pendingDepositAmount display hints if
          // they were set (by a future RawEventsGatherer L1 indexer — for now
          // these are written by the existing PATCH path and reset here for
          // cleanliness when the deposit fully lands).
          await prisma.user.updateMany({
            where: { tokenId: senderId },
            data: { lastStakedAt: null, pendingDepositAmount: null }
          }).catch(() => {})
          continue
        }

        if (isAuthenticated && cawBalance === 0n) {
          logger.log(`[PendingMintDeposit] Sender ${senderId}: auth landed but balance still 0 — holding`)
        }

        // Not fully ready — check if any rows for this sender have timed
        // out (>20 min old) and fail just those via the shared choke point
        // so a notification is created alongside the DB update. Keep newer
        // rows waiting.
        const staleRows = rows.filter(r => r.createdAt < twentyMinutesAgo)
        if (staleRows.length > 0) {
          for (const row of staleRows) {
            const actionData = (row.payload as any)?.data ?? {}
            await markTxQueueFailed(
              prisma,
              row.id,
              'Deposit did not arrive from L1 in time. Please try again.',
              row.senderId,
              actionData
            )
          }
          logger.log(`[PendingMintDeposit] Sender ${senderId}: timed out ${staleRows.length} rows (>20 min)`)
        }
      } catch (err: any) {
        logger.error(`[PendingMintDeposit] Sender ${senderId} check failed: ${err.message}`)
      }
    }
  } catch (err: any) {
    logger.error(`[PendingMintDeposit] Fatal: ${err.message}`)
  }
}

/**
 * Main cleanup function that runs all data cleaning tasks
 */
async function runDataCleanup() {
  logger.log('Running data cleanup tasks...')

  // Clean up pending likes
  await cleanupPendingLikes()

  // Clean up pending tips
  await cleanupPendingTips()

  // Clean up pending caws (posts)
  await cleanupPendingCaws()

  // Clean up pending replies
  await cleanupPendingReplies()

  // Clean up pending follows
  await cleanupPendingFollows()

  // Clean up failed txqueue records and update associated caws
  await cleanupFailedTxQueue()

  // Promote waiting_for_deposit rows once their L1 deposit has landed on L2
  await cleanupPendingMintDeposits()

  logger.log('All cleanup tasks completed')
}

/**
 * Start the background worker
 * Runs every 5 minutes to clean up stale data
 */
function startDataCleanerWorker(heartbeat?: () => void) {
  const date = new Date().toISOString().split('T')[0]
  console.log(`[DataCleaner] Starting background worker... Logs will be written to logs/data-cleaner-${date}.log`)
  logger.log('Starting background worker...')

  const runAndBeat = async () => {
    try {
      await runDataCleanup()
    } finally {
      heartbeat?.()
    }
  }

  // Run immediately on startup
  runAndBeat()

  // Then run every 1 minute for more responsive cleanup
  setInterval(runAndBeat, 1 * 60 * 1000) // 1 minute
}

// Export for use as a service
export const dataCleanerService = {
  name: 'DataCleaner',

  validateConfig(cfg: unknown) {
    // No configuration needed for this service
    return []
  },

  start(_cfg: unknown, ctx: import('../../Service').HeartbeatContext) {
    ctx.declareLoop('cleanup', 5 * 60_000) // 5× 1-minute interval
    startDataCleanerWorker(() => ctx.heartbeat('cleanup'))

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
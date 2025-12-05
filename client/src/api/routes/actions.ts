import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { processHashtagsForCaw } from '../../tools/hashtags'

const router = Router()

/**
 * natstat: enqueue signed actions into TxQueue
 */
router.post('/', async (req, res) => {
  try {
    const { data, domain, types, signature } = req.body

    // Validate required fields
    if (!data || !signature) {
      return res.status(400).json({ error: 'Missing required fields: data and signature' })
    }

    // Validate and sanitize amounts field
    if (data.amounts && Array.isArray(data.amounts)) {
      data.amounts = data.amounts.map((amt: any) => {
        if (amt === null || amt === undefined || amt === '') {
          return '0'
        }
        const strAmt = String(amt)
        if (strAmt === 'NaN' || isNaN(Number(strAmt))) {
          console.warn(`Invalid amount value in action: ${amt}, defaulting to 0`)
          return '0'
        }
        return strAmt
      })
    } else {
      data.amounts = []
    }

    // Create optimistic pending state for profile updates
    if (data.actionType === 'other' && data.text && (data.text.startsWith('p:') || data.text.startsWith('profile-update:'))) {
      try {
        await prisma.user.update({
          where: { tokenId: data.senderId },
          data: { profileUpdatePending: true }
        })
      } catch (updateErr) {
        console.error('Failed to set profile update pending:', updateErr)
        // Continue even if setting pending state fails
      }
    }

    // Create optimistic pending caw for CAW actions
    if (data.actionType === 0 || data.actionType === 'caw') { // 0 is the enum value for 'caw'
      try {
        console.log('Creating optimistic pending caw for user:', data.senderId, 'cawonce:', data.cawonce)

        // Ensure user exists first
        const user = await prisma.user.findUnique({
          where: { tokenId: data.senderId }
        })

        if (!user) {
          // Create user if doesn't exist
          await prisma.user.create({
            data: { tokenId: data.senderId }
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
            console.log(`Found parent caw ID ${originalCawId} for reply`)
          } else {
            console.log(`Warning: Parent caw not found for receiverId ${data.receiverId}, receiverCawonce ${data.receiverCawonce}`)
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
            status: 'PENDING', // If it already exists, mark as pending
            originalCawId: originalCawId || null, // Update originalCawId for replies
            updatedAt: new Date()
          },
          create: {
            userId: data.senderId,
            cawonce: data.cawonce,
            content: textContent,
            action: 'CAW',
            status: 'PENDING', // Mark as pending
            originalCawId: originalCawId || null, // Set originalCawId for replies
            imageData: imageUrls.length > 0 ? `urls:${imageUrls.join('|||')}` : null,
            hasImage: imageUrls.length > 0,
            videoData: videoUrls.length > 0 ? videoUrls.join('|||') : null,
            hasVideo: videoUrls.length > 0
          }
        })

        console.log(`Created/Updated pending caw: ID=${caw.id}, userId=${caw.userId}, cawonce=${caw.cawonce}, status=${caw.status}`)

        // Process hashtags for the new caw
        try {
          await processHashtagsForCaw(caw.id, textContent)
          console.log(`Processed hashtags for caw ${caw.id}`)
        } catch (err) {
          console.error(`Failed to process hashtags for caw ${caw.id}:`, err)
          // Don't fail the request if hashtag processing fails
        }
        console.log('Successfully created optimistic pending caw with ID:', caw.id)
      } catch (cawErr) {
        console.error('Failed to create optimistic pending caw:', cawErr)
        // Continue even if optimistic caw creation fails
      }
    }

    // Debug logging for all actions
    console.log('Received action:', {
      actionType: data.actionType,
      senderId: data.senderId,
      receiverId: data.receiverId,
      receiverCawonce: data.receiverCawonce,
      text: data.text?.substring(0, 50) // First 50 chars for debugging
    })

    // Create optimistic pending like if this is a like action
    if (data.actionType === 1) {  // 1 is the enum value for 'like'
      console.log('Processing LIKE action - creating pending like record')
      console.log('Looking for caw with userId:', data.receiverId, 'and cawonce:', data.receiverCawonce)

      try {
        // Find the target caw ID
        const targetCaw = await prisma.caw.findFirst({
          where: {
            userId: data.receiverId,
            cawonce: data.receiverCawonce
          }
        })

        if (targetCaw) {
          console.log('Found target caw:', targetCaw.id, 'creating pending like for user:', data.senderId)
          // Create pending like (ignore if it already exists)
          const pendingLike = await prisma.like.upsert({
            where: {
              userId_cawId: {
                userId: data.senderId,
                cawId: targetCaw.id
              }
            },
            update: {
              pending: true,
              action: 'LIKE'
            },
            create: {
              userId: data.senderId,
              cawId: targetCaw.id,
              action: 'LIKE',
              pending: true
            }
          })
          console.log('Successfully created/updated pending like:', pendingLike)
        } else {
          console.log('Target caw not found for receiverId:', data.receiverId, 'cawonce:', data.receiverCawonce)

          // Let's check what caws exist for this user
          const userCaws = await prisma.caw.findMany({
            where: { userId: data.receiverId },
            select: { cawonce: true, id: true },
            orderBy: { cawonce: 'desc' },
            take: 5
          })
          console.log('Recent caws for receiverId', data.receiverId, ':', userCaws)
        }
      } catch (likeErr) {
        console.error('Failed to create pending like:', likeErr)
        // Continue even if pending like creation fails
      }
    }

    // Create optimistic pending follow if this is a follow action
    if (data.actionType === 4 || data.actionType === 'follow') {  // 4 is the enum value for 'follow'
      console.log('Processing FOLLOW action - creating pending follow record')
      console.log('Follower:', data.senderId, 'Following:', data.receiverId)

      try {
        // Ensure both users exist
        await Promise.all([
          prisma.user.upsert({
            where: { tokenId: data.senderId },
            update: {},
            create: { tokenId: data.senderId, username: `user${data.senderId}`, address: '0x0' }
          }),
          prisma.user.upsert({
            where: { tokenId: data.receiverId },
            update: {},
            create: { tokenId: data.receiverId, username: `user${data.receiverId}`, address: '0x0' }
          })
        ])

        // Create pending follow (or update existing to pending)
        const pendingFollow = await prisma.follow.upsert({
          where: {
            followerId_followingId: {
              followerId: data.senderId,
              followingId: data.receiverId
            }
          },
          update: {
            status: 'PENDING',
            action: 'FOLLOW'
          },
          create: {
            followerId: data.senderId,
            followingId: data.receiverId,
            action: 'FOLLOW',
            status: 'PENDING'
          }
        })
        console.log('Successfully created/updated pending follow:', pendingFollow.id)
      } catch (followErr) {
        console.error('Failed to create pending follow:', followErr)
        // Continue even if pending follow creation fails
      }
    }

    // Handle unfollow action - remove or mark as failed any pending follows
    if (data.actionType === 5 || data.actionType === 'unfollow') {  // 5 is the enum value for 'unfollow'
      console.log('Processing UNFOLLOW action - marking follow as pending removal')
      console.log('Unfollower:', data.senderId, 'Unfollowing:', data.receiverId)

      try {
        // Mark existing follow as PENDING (will be deleted when processed)
        const updatedFollow = await prisma.follow.updateMany({
          where: {
            followerId: data.senderId,
            followingId: data.receiverId,
            action: 'FOLLOW'
          },
          data: {
            status: 'PENDING'
          }
        })
        console.log('Marked follow as pending for removal:', updatedFollow.count, 'records')
      } catch (unfollowErr) {
        console.error('Failed to mark follow as pending removal:', unfollowErr)
        // Continue even if marking fails
      }
    }

    // Create withdrawal request if this is a withdraw action
    if (data.actionType === 6 || data.actionType === '6') {  // 6 is the enum value for 'withdraw'
      console.log('Processing WITHDRAW action - creating withdrawal request')
      console.log('Withdrawal details:', {
        userId: data.senderId,
        amounts: data.amounts,
        cawonce: data.cawonce
      })

      try {
        const withdrawalAmount = data.amounts && data.amounts[0] ? data.amounts[0].toString() : '0'
        const withdrawalRequest = await prisma.withdrawalRequest.create({
          data: {
            userId: data.senderId,
            amount: withdrawalAmount,
            cawonce: data.cawonce,
            status: 'pending'
          }
        })
        console.log(`✅ Created withdrawal request ${withdrawalRequest.id} for user ${data.senderId}, amount: ${withdrawalAmount} CAW, cawonce: ${data.cawonce}`)
      } catch (withdrawErr) {
        console.error('❌ Failed to create withdrawal request:', withdrawErr)
        // Continue even if withdrawal request creation fails
      }
    }

    // Create the transaction queue entry
    const txQueueEntry = await prisma.txQueue.create({
      data: {
        senderId: data.senderId,          // ← pull out the on-chain sender
        payload: { data, domain, types },
        signedTx: signature
      }
    })
    console.log(`Created TxQueue entry ${txQueueEntry.id} for action type ${data.actionType}, senderId ${data.senderId}, cawonce ${data.cawonce}`)

    // Verify pending caw was created if this is a CAW action
    if (data.actionType === 0 || data.actionType === 'caw') {
      const pendingCaw = await prisma.caw.findUnique({
        where: {
          userId_cawonce: {
            userId: data.senderId,
            cawonce: data.cawonce
          }
        }
      })

      if (pendingCaw) {
        console.log(`✅ Verified pending caw exists: ID ${pendingCaw.id}, status ${pendingCaw.status}`)
      } else {
        console.error(`❌ WARNING: Pending caw NOT found after creation for userId ${data.senderId}, cawonce ${data.cawonce}`)
      }
    }

    res.status(201).json({ status: 'queued', txQueueId: txQueueEntry.id })
  } catch (err: any) {
    console.error('POST /api/actions error', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

export default router



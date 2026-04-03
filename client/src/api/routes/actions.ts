import { Router } from 'express'
import { ethers } from 'ethers'
import { prisma } from '../../prismaClient'
import { CawStatus } from '@prisma/client'
import { findOrCreateUser } from '../../services/UserService'
import { getSession, addAuthorization, createSession } from '../sessionStore'

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

    // --- Passive auth accumulation ---
    // Creates or updates a session when we can verify the signer.
    // Works for both direct wallet signatures and session key (Quick Sign) signatures:
    // - Direct: recovered address matches the token owner → authorize owner
    // - Session key: recovered address differs (it's the ephemeral key) → still authorize
    //   the token owner, since we trust the sender's on-chain session key delegation
    let authResult: { sessionToken: string; authorizedTokenIds: number[]; authorizedAddresses: string[]; expiresAt: number } | null = null
    let sessionToken = req.headers['x-session-token'] as string | undefined
    if (signature && data.senderId !== undefined) {
      try {
        const sender = await prisma.user.findUnique({ where: { tokenId: data.senderId } })
        if (sender?.address) {
          // Check if address is already authorized in existing session
          let session = sessionToken ? await getSession(sessionToken) : null
          const ownerAddress = sender.address.toLowerCase()
          const alreadyAuthorized = session?.authorizedAddresses.includes(ownerAddress)

          if (!alreadyAuthorized) {
            // Recover the signer from the EIP-712 signature
            const recoveredAddress = ethers.verifyTypedData(
              domain,
              { ActionData: types.ActionData },
              data,
              signature
            ).toLowerCase()

            // Accept if signer is either the token owner (direct wallet sign)
            // or a different address (session key sign — the contract will validate
            // the delegation on-chain; we authorize the owner either way so the
            // HTTP session covers all tokens owned by that address)
            const isOwner = recoveredAddress === ownerAddress
            const isSessionKey = recoveredAddress !== ownerAddress

            if (isOwner || isSessionKey) {
              // Authorize all tokenIds for the token owner's address
              const userTokens = await prisma.user.findMany({
                where: { address: ownerAddress },
                select: { tokenId: true }
              })
              const tokenIds = userTokens.map(u => u.tokenId)

              if (!session) {
                const created = await createSession()
                sessionToken = created.token
                session = created.session
              }

              const updated = await addAuthorization(sessionToken!, ownerAddress, tokenIds)
              if (updated) {
                authResult = {
                  sessionToken: sessionToken!,
                  authorizedTokenIds: updated.authorizedTokenIds,
                  authorizedAddresses: updated.authorizedAddresses,
                  expiresAt: updated.expiresAt
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn('[Actions] Passive auth failed (non-fatal):', err)
      }
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

        // Ensure user exists first - fetch from chain if needed
        try {
          await findOrCreateUser(data.senderId)
        } catch (userErr) {
          console.error('Failed to find/create user from chain:', userErr)
          // Continue anyway - the caw will be created with userId reference
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
        if (data.receiverId && data.receiverCawonce !== undefined && data.receiverCawonce !== null) {
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
        // Note: Hashtags are processed later when the caw is confirmed (in ActionProcessor)
        // This prevents pending/failed caws from affecting trending hashtags

        // Clean up old FAILED caws with the same content (retries)
        if (textContent) {
          const deleted = await prisma.caw.deleteMany({
            where: {
              userId: data.senderId,
              content: textContent,
              status: 'FAILED',
              id: { not: caw.id }
            }
          })
          if (deleted.count > 0) {
            console.log(`Cleaned up ${deleted.count} old failed caw(s) replaced by retry`)
          }
        }

        // Create pending Reply record if this is a reply (not a quote)
        if (originalCawId && caw && !data.isQuote) {
          try {
            await prisma.reply.upsert({
              where: {
                userId_cawId_replyCawId: {
                  userId: data.senderId,
                  cawId: originalCawId,
                  replyCawId: caw.id
                }
              },
              update: { pending: true },
              create: {
                userId: data.senderId,
                cawId: originalCawId,
                replyCawId: caw.id,
                pending: true
              }
            })
            console.log(`Created pending Reply record: userId=${data.senderId}, cawId=${originalCawId}, replyCawId=${caw.id}`)
          } catch (replyErr) {
            console.error('Failed to create pending Reply record:', replyErr)
            // Continue even if Reply record creation fails
          }
        }
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
        // Ensure both users exist (id = tokenId)
        await Promise.all([
          prisma.user.upsert({
            where: { tokenId: data.senderId },
            update: {},
            create: { id: data.senderId, tokenId: data.senderId, username: `user_${data.senderId}` }
          }),
          prisma.user.upsert({
            where: { tokenId: data.receiverId },
            update: {},
            create: { id: data.receiverId, tokenId: data.receiverId, username: `user_${data.receiverId}` }
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

    // Create pending tip if this is a tip action (OTHER with tip: prefix)
    if ((data.actionType === 7 || data.actionType === 'other') && data.text?.startsWith('tip:')) {
      console.log('Processing TIP action - creating pending tip record')

      try {
        const recipientTokenId = data.recipients?.[0]
        const tipAmount = data.amounts?.[0]

        if (recipientTokenId && tipAmount) {
          // Ensure both users exist
          await Promise.all([
            prisma.user.upsert({
              where: { tokenId: data.senderId },
              update: {},
              create: { id: data.senderId, tokenId: data.senderId, username: `user_${data.senderId}` }
            }),
            prisma.user.upsert({
              where: { tokenId: Number(recipientTokenId) },
              update: {},
              create: { id: Number(recipientTokenId), tokenId: Number(recipientTokenId), username: `user_${recipientTokenId}` }
            })
          ])

          // Parse target caw from text: "tip:userId:cawonce"
          let cawId: number | null = null
          const parts = data.text.replace('tip:', '').split(':')
          if (parts.length >= 2 && parts[0] && parts[1]) {
            const targetUserId = parseInt(parts[0])
            const targetCawonce = parseInt(parts[1])
            if (!isNaN(targetUserId) && !isNaN(targetCawonce)) {
              const targetCaw = await prisma.caw.findUnique({
                where: { userId_cawonce: { userId: targetUserId, cawonce: targetCawonce } }
              })
              cawId = targetCaw?.id ?? null
            }
          }

          const pendingTip = await prisma.tip.create({
            data: {
              senderId: data.senderId,
              recipientId: Number(recipientTokenId),
              amount: Number(tipAmount),
              cawId,
              cawonce: data.cawonce,
              pending: true
            }
          })
          console.log('Successfully created pending tip:', pendingTip.id)
        }
      } catch (tipErr) {
        console.error('Failed to create pending tip:', tipErr)
        // Continue even if pending tip creation fails
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

    // Create the transaction queue entry (or return existing if duplicate signature)
    let txQueueEntry
    try {
      txQueueEntry = await prisma.txQueue.create({
        data: {
          senderId: data.senderId,          // ← pull out the on-chain sender
          payload: { data, domain, types },
          signedTx: signature
        }
      })
    } catch (err: any) {
      if (err.code === 'P2002') {
        // Duplicate signature — find the existing entry and return it
        const existing = await prisma.txQueue.findFirst({ where: { signedTx: signature } })
        if (existing) {
          console.log(`Duplicate submission for txQueue ${existing.id}, returning existing entry`)
          return res.json({ txQueueId: existing.id, status: existing.status })
        }
      }
      throw err
    }
    console.log(`Created TxQueue entry ${txQueueEntry.id} for action type ${data.actionType}, senderId ${data.senderId}, cawonce ${data.cawonce}`)

    // Create pending OnChainImage if this is an image upload action
    if ((data.actionType === 7 || data.actionType === 'other') && data.text?.startsWith('image64:')) {
      try {
        const base64Data = data.text.replace('image64:', '')
        const imageRef = `img:${data.senderId}:${data.cawonce}`
        const cawCost = data.amounts?.[0] ? Number(data.amounts[0]) : 0

        await prisma.onChainImage.upsert({
          where: { imageRef },
          update: {
            txQueueId: txQueueEntry.id
          },
          create: {
            userId: data.senderId,
            txQueueId: txQueueEntry.id,
            imageRef,
            cawonce: data.cawonce,
            base64Data,
            cawCost,
            status: CawStatus.PENDING
          }
        })
        console.log(`Created pending OnChainImage: imageRef=${imageRef}, txQueueId=${txQueueEntry.id}, cawCost=${cawCost}`)
      } catch (imgErr) {
        console.error('Failed to create pending OnChainImage:', imgErr)
      }
    }

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

    res.status(201).json({
      status: 'queued',
      txQueueId: txQueueEntry.id,
      ...(authResult ? { auth: authResult } : {})
    })
  } catch (err: any) {
    console.error('POST /api/actions error', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

export default router



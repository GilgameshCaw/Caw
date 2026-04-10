import { Router } from 'express'
import { ethers, JsonRpcProvider, WebSocketProvider, Contract } from 'ethers'
import { prisma } from '../../prismaClient'
import { CawStatus } from '@prisma/client'
import { findOrCreateUser } from '../../services/UserService'
import { getSession, addAuthorization, createSession } from '../sessionStore'
import { cawNameL2Abi } from '../../abi/generated'
import { CAW_NAMES_L2_ADDRESS } from '../../abi/addresses'

const router = Router()

// Rate limiting for free actions (unlike, unfollow) to prevent validator griefing.
// These actions cost 0 CAW so an attacker could spam them to waste validator gas.
const FREE_ACTION_CODES = [2, 5] // unlike=2, unfollow=5
const FREE_ACTION_LIMIT = 30 // max per minute per sender
const freeActionCounts = new Map<number, { count: number; resetAt: number }>()

function checkFreeActionRate(senderId: number, actionType: number): boolean {
  if (!FREE_ACTION_CODES.includes(actionType)) return true
  const now = Date.now()
  const entry = freeActionCounts.get(senderId)
  if (!entry || now > entry.resetAt) {
    freeActionCounts.set(senderId, { count: 1, resetAt: now + 60_000 })
    return true
  }
  entry.count++
  return entry.count <= FREE_ACTION_LIMIT
}

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of freeActionCounts) {
    if (now > entry.resetAt) freeActionCounts.delete(key)
  }
}, 5 * 60_000)

// Lazy-initialized read-only provider for on-chain session key verification
let _readProvider: JsonRpcProvider | WebSocketProvider | null = null
let _readContract: Contract | null = null

function getReadContract(): Contract {
  if (_readContract) return _readContract
  const rpcUrl = process.env.L2_RPC_URL_HTTP || process.env.L2_RPC_URL
  if (!rpcUrl) throw new Error('L2 RPC not configured')
  _readProvider = rpcUrl.startsWith('wss://') || rpcUrl.startsWith('ws://')
    ? new WebSocketProvider(rpcUrl)
    : new JsonRpcProvider(rpcUrl)
  _readContract = new Contract(CAW_NAMES_L2_ADDRESS, cawNameL2Abi as any, _readProvider)
  return _readContract
}

interface SessionKeyCheck {
  valid: boolean
  reason?: string
}

async function checkSessionKeyOnChain(
  ownerAddress: string,
  sessionKeyAddress: string,
  actionType?: number
): Promise<SessionKeyCheck> {
  try {
    const contract = getReadContract()
    const session = await contract.sessions(ownerAddress, sessionKeyAddress)
    const expiry = Number(session.expiry)
    const scopeBitmap = Number(session.scopeBitmap)
    const spendLimit = BigInt(session.spendLimit?.toString() || '0')

    if (expiry === 0) {
      return { valid: false, reason: 'Session key not registered' }
    }

    if (expiry <= Math.floor(Date.now() / 1000)) {
      return { valid: false, reason: 'Session key expired' }
    }

    // Check scope if action type is provided
    if (actionType !== undefined && actionType <= 7) {
      if ((scopeBitmap & (1 << actionType)) === 0) {
        return { valid: false, reason: 'Action type not in session scope' }
      }
    }

    // Check spend limit (read on-chain spent amount)
    if (spendLimit > 0n) {
      try {
        // CawActions.sessionSpent(owner, sessionKey) returns the amount spent
        const actionsContract = new Contract(
          (await import('../../abi/addresses')).CAW_ACTIONS_ADDRESS,
          (await import('../../abi/generated')).cawActionsAbi as any,
          _readProvider!
        )
        const spent = BigInt((await actionsContract.sessionSpent(ownerAddress, sessionKeyAddress)).toString())
        if (spent >= spendLimit) {
          return { valid: false, reason: 'Session key spend limit reached' }
        }
      } catch {
        // If we can't check spend, allow it — the contract will enforce
      }
    }

    return { valid: true }
  } catch (err) {
    // RPC failure — allow the action through rather than blocking users when the RPC is down.
    // The on-chain contract will enforce session key validation when the validator submits the batch,
    // so this server-side check is just an early rejection optimization, not a security boundary.
    console.warn('[Actions] On-chain session key verification failed (allowing action — contract will enforce):', err)
    return { valid: true }
  }
}

/**
 * natstat: enqueue signed actions into TxQueue
 */
router.post('/', async (req, res) => {
  try {
    const { data, domain, types, signature, isQuote, pendingDepositTxHash } = req.body

    // Validate pendingDepositTxHash shape if provided. The server does NOT verify
    // the hash synchronously (that would block the request path on an L1 RPC call).
    // Instead, presence of this hash on the TxQueue row is a signal to the validator
    // to hold the action as waiting_for_deposit rather than fail it, and to the
    // DataCleaner watcher to re-check L2 on each tick until the deposit lands.
    // Grief is bounded by a per-sender slot limit enforced below.
    let sanitizedPendingDepositTxHash: string | null = null
    if (pendingDepositTxHash !== undefined && pendingDepositTxHash !== null) {
      if (typeof pendingDepositTxHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(pendingDepositTxHash)) {
        return res.status(400).json({ error: 'Invalid pendingDepositTxHash format' })
      }
      sanitizedPendingDepositTxHash = pendingDepositTxHash.toLowerCase()
    }

    // Validate required fields
    if (!data || !signature) {
      return res.status(400).json({ error: 'Missing required fields: data and signature' })
    }

    // Limit payload size — on-chain images use a separate flow (OnChainImage model),
    // so action text shouldn't need more than ~100KB (base64 image + metadata overhead)
    const bodySize = JSON.stringify(req.body).length
    if (bodySize > 100 * 1024) {
      return res.status(413).json({ error: 'Payload too large (max 100KB)' })
    }

    // Rate limit free actions (unlike/unfollow) to prevent validator gas griefing
    if (!checkFreeActionRate(data.senderId, data.actionType)) {
      return res.status(429).json({ error: 'Too many free actions. Please slow down.' })
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

    // --- Signer verification (mandatory) ---
    // Recover the EIP-712 signer and verify they are authorized to act on behalf of senderId.
    // Rejects with 403 if the signer is neither the token owner nor a valid session key delegate.
    // This prevents queuing actions that will definitely fail on-chain.
    let recoveredAddress: string | null = null
    let ownerAddress: string | null = null
    const sender = await prisma.user.findUnique({ where: { tokenId: data.senderId } })

    if (!sender?.address) {
      return res.status(400).json({ error: 'Unknown sender' })
    }

    ownerAddress = sender.address.toLowerCase()

    try {
      recoveredAddress = ethers.verifyTypedData(
        domain,
        { ActionData: types.ActionData },
        data,
        signature
      ).toLowerCase()
    } catch (err) {
      return res.status(400).json({ error: 'Invalid signature' })
    }

    const isOwner = recoveredAddress === ownerAddress

    if (!isOwner) {
      // Check if signer is a valid session key for this owner
      const actionType = typeof data.actionType === 'number' ? data.actionType : undefined
      const sessionCheck = await checkSessionKeyOnChain(ownerAddress, recoveredAddress, actionType)

      if (!sessionCheck.valid) {
        console.warn(`[Actions] Rejected: signer ${recoveredAddress} not authorized for owner ${ownerAddress}: ${sessionCheck.reason}`)
        return res.status(403).json({ error: sessionCheck.reason || 'Signer is not authorized for this token' })
      }
    }

    // --- Passive auth accumulation ---
    // Now that the signer is verified, create/extend the HTTP session for the token owner.
    let authResult: { sessionToken: string; authorizedTokenIds: number[]; authorizedAddresses: string[]; expiresAt: number } | null = null
    let sessionToken = req.headers['x-session-token'] as string | undefined
    try {
      let session = sessionToken ? await getSession(sessionToken) : null
      const alreadyAuthorized = session?.authorizedAddresses.includes(ownerAddress)

      if (!alreadyAuthorized) {
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
      } else if (session && sessionToken) {
        // Already authorized — but re-check DB for any new token IDs the user may have
        // acquired since the session was created (e.g., bought/transferred a new CawName).
        // This ensures the session stays in sync with on-chain ownership.
        const userTokens = await prisma.user.findMany({
          where: { address: ownerAddress },
          select: { tokenId: true }
        })
        const currentTokenIds = userTokens.map(u => u.tokenId)
        const hasNewTokens = currentTokenIds.some(id => !session!.authorizedTokenIds.includes(id))

        if (hasNewTokens) {
          const updated = await addAuthorization(sessionToken, ownerAddress, currentTokenIds)
          if (updated) {
            authResult = {
              sessionToken,
              authorizedTokenIds: updated.authorizedTokenIds,
              authorizedAddresses: updated.authorizedAddresses,
              expiresAt: updated.expiresAt
            }
          }
        } else {
          // Return existing session data so the frontend can resync its local state
          authResult = {
            sessionToken,
            authorizedTokenIds: session.authorizedTokenIds,
            authorizedAddresses: session.authorizedAddresses,
            expiresAt: session.expiresAt
          }
        }
      }
    } catch (err: any) {
      console.error('[Actions] ❌ PASSIVE AUTH FAILED:', err?.message || err)
      console.error('[Actions] Stack:', err?.stack)
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

    // Create optimistic pending caw for CAW and RECAW actions
    const isRecaw = data.actionType === 3 || data.actionType === 'recaw'
    const isRecawQuote = isRecaw && data.text && data.text.trim().length > 0
    if (data.actionType === 0 || data.actionType === 'caw' || isRecaw) { // 0=caw, 3=recaw (plain or quote)
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

        // Check if caw already exists (to know if we need to increment counts)
        const existingCaw = await prisma.caw.findUnique({
          where: { userId_cawonce: { userId: data.senderId, cawonce: data.cawonce } }
        })

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
            action: isRecaw ? 'RECAW' : 'CAW',
            status: 'PENDING', // Mark as pending
            originalCawId: originalCawId || null, // Set originalCawId for replies/quotes
            imageData: imageUrls.length > 0 ? `urls:${imageUrls.join('|||')}` : null,
            hasImage: imageUrls.length > 0,
            videoData: videoUrls.length > 0 ? videoUrls.join('|||') : null,
            hasVideo: videoUrls.length > 0
          }
        })

        console.log(`Created/Updated pending caw: ID=${caw.id}, userId=${caw.userId}, cawonce=${caw.cawonce}, status=${caw.status}`)
        // Note: Hashtags are processed later when the caw is confirmed (in ActionProcessor)
        // This prevents pending/failed caws from affecting trending hashtags

        // Optimistically increment recawCount on the parent caw for recaws
        if (isRecaw && originalCawId && !existingCaw) {
          try {
            await prisma.caw.update({
              where: { id: originalCawId },
              data: { recawCount: { increment: 1 } }
            })
            console.log(`Optimistically incremented recawCount for caw: ${originalCawId}`)
          } catch (err) {
            console.error('Failed to optimistically increment recawCount:', err)
          }
        }

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

        // Create pending Reply record if this is a reply (not a quote/recaw)
        if (originalCawId && caw && !isQuote && !isRecawQuote) {
          try {
            // Check if reply already exists
            const existingReply = await prisma.reply.findUnique({
              where: { userId_cawId_replyCawId: { userId: data.senderId, cawId: originalCawId, replyCawId: caw.id } }
            })
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
            // Optimistically increment commentCount if this is a new pending reply
            if (!existingReply) {
              await prisma.caw.update({
                where: { id: originalCawId },
                data: { commentCount: { increment: 1 } }
              })
              console.log(`Optimistically incremented commentCount for caw: ${originalCawId}`)
            }
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
          // Check if like already exists (to know if we need to increment count)
          const existingLike = await prisma.like.findUnique({
            where: { userId_cawId: { userId: data.senderId, cawId: targetCaw.id } }
          })
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
          // Optimistically increment likeCount if this is a new pending like
          if (!existingLike) {
            await prisma.caw.update({
              where: { id: targetCaw.id },
              data: { likeCount: { increment: 1 } }
            })
            console.log('Optimistically incremented likeCount for caw:', targetCaw.id)
          }
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

    // Per-sender cap on waiting_for_deposit slots. An attacker who knows a sender's
    // tokenId could spam actions with a fake pendingDepositTxHash to fill the queue
    // with rows that sit waiting for 20 min. Capping at 10 in-flight waiting rows
    // per sender limits the blast radius to their own queue (which they already
    // control anyway — they'd have to sign each action themselves).
    if (sanitizedPendingDepositTxHash) {
      const existingWaiting = await prisma.txQueue.count({
        where: { senderId: data.senderId, status: 'waiting_for_deposit' }
      })
      if (existingWaiting >= 10) {
        return res.status(429).json({ error: 'Too many actions waiting for deposit. Please wait for them to process.' })
      }
    }

    // Create the transaction queue entry (or return existing if duplicate signature)
    let txQueueEntry
    try {
      txQueueEntry = await prisma.txQueue.create({
        data: {
          senderId: data.senderId,          // ← pull out the on-chain sender
          payload: { data, domain, types, isQuote: isQuote || false },
          signedTx: signature,
          pendingDepositTxHash: sanitizedPendingDepositTxHash
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



import { Router } from 'express'
import { ethers, JsonRpcProvider, WebSocketProvider, Contract } from 'ethers'
import { makeJsonRpcProvider, makeWebSocketProvider, getL2HttpRpcUrl } from '../../utils/rpcProvider'
import SmlTxt from 'smltxt'
import { prisma } from '../../prismaClient'

// smltxt singleton for decompressing the `bytes text` field signed by clients.
// `data.text` arrives as 0x-hex of compressed bytes — keep it that way for the
// validator's on-chain submission (the signature was over those exact bytes),
// and derive plaintext separately for storage / URL extraction / tip parsing.
let _smlTxt: SmlTxt | undefined
function smlTxt(): SmlTxt {
  if (!_smlTxt) _smlTxt = SmlTxt.fromPkg()
  return _smlTxt
}
function decompressActionText(textField: unknown): string {
  if (typeof textField !== 'string' || !textField || textField === '0x') return ''
  const hex = textField.startsWith('0x') ? textField.slice(2) : textField
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return ''
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  try { return smlTxt().decompress(bytes) } catch { return '' }
}
// Tier 1 of the "RPC out of API request handlers" refactor: do NOT call
// findOrCreateUser from the request path. If the sender row is missing, we
// 202 and let RawEventsGatherer's Mint listener / NftTransferWatcher backfill.
import { countManager } from '../../services/CountManager'
import { parsePoll, parseVoteText } from '../../tools/pollMarker'
import { getSession, addAuthorization, createSession } from '../sessionStore'
import { cawProfileL2Abi } from '../../abi/generated'
import { CAW_NAMES_L2_ADDRESS } from '../../abi/addresses'
import { packActions, getPackedActionSlices } from '../../utils/packActions'

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
  const rpcUrl = getL2HttpRpcUrl()
  if (!rpcUrl) throw new Error('L2 RPC not configured')
  _readProvider = rpcUrl.startsWith('wss://') || rpcUrl.startsWith('ws://')
    ? makeWebSocketProvider(rpcUrl, 84532)
    : makeJsonRpcProvider(rpcUrl, 84532)
  _readContract = new Contract(CAW_NAMES_L2_ADDRESS, cawProfileL2Abi as any, _readProvider)
  return _readContract
}

interface SessionKeyCheck {
  valid: boolean
  reason?: string
}

/**
 * Validate a session key against the local SessionKey table, which is kept
 * in sync with on-chain state by ChainSyncService's L2Events indexer. Only
 * falls back to a live RPC read if the session isn't in our DB yet — rare
 * in steady state (the indexer runs every 15 seconds), common only for
 * brand-new sessions created seconds ago.
 *
 * IMPORTANT: This check is purely for early rejection. The contract enforces
 * session-key validity on-chain during the validator's processActions call,
 * so letting an invalid session slip through here only wastes a validator
 * simulation — it cannot result in an unauthorized on-chain action.
 */
async function checkSessionKeyOnChain(
  ownerAddress: string,
  sessionKeyAddress: string,
  actionType?: number
): Promise<SessionKeyCheck> {
  const owner = ownerAddress.toLowerCase()
  const sessionAddr = sessionKeyAddress.toLowerCase()
  const nowSec = Math.floor(Date.now() / 1000)

  // --- Fast path: local DB lookup ---
  const row = await prisma.sessionKey.findUnique({
    where: { ownerAddress_sessionAddress: { ownerAddress: owner, sessionAddress: sessionAddr } },
  })

  if (row) {
    if (row.revokedAt) return { valid: false, reason: 'Session key revoked' }
    const expirySec = Number(row.expiry)
    if (expirySec === 0) return { valid: false, reason: 'Session key not registered' }
    if (expirySec <= nowSec) return { valid: false, reason: 'Session key expired' }
    if (actionType !== undefined && actionType <= 7 && (row.scopeBitmap & (1 << actionType)) === 0) {
      return { valid: false, reason: 'Action type not in session scope' }
    }
    // Spend limit check against locally-tracked spent total.
    // The validator updates row.spent after a successful batch, and the
    // contract enforces the real limit — so a stale cache only under-counts
    // (too permissive), never over-counts (too restrictive).
    const spendLimit = BigInt(row.spendLimit || '0')
    if (spendLimit > 0n) {
      const spent = BigInt(row.spent || '0')
      if (spent >= spendLimit) return { valid: false, reason: 'Session key spend limit reached' }
    }
    return { valid: true }
  }

  // --- Slow path: not in DB yet (brand-new session, or indexer catching up).
  // Make a live RPC call, then persist so future requests hit the fast path.
  try {
    const contract = getReadContract()
    const session = await contract.sessions(owner, sessionAddr)
    const expirySec = Number(session.expiry)
    const scopeBitmap = Number(session.scopeBitmap)
    const spendLimit = BigInt(session.spendLimit?.toString() || '0')

    if (expirySec === 0) return { valid: false, reason: 'Session key not registered' }

    // Persist for subsequent requests (best-effort; don't fail the request)
    try {
      await prisma.sessionKey.upsert({
        where: { ownerAddress_sessionAddress: { ownerAddress: owner, sessionAddress: sessionAddr } },
        update: {
          expiry: BigInt(expirySec),
          scopeBitmap,
          spendLimit: spendLimit.toString(),
          revokedAt: null,
          lastSyncedAt: new Date(),
        },
        create: {
          ownerAddress: owner,
          sessionAddress: sessionAddr,
          expiry: BigInt(expirySec),
          scopeBitmap,
          spendLimit: spendLimit.toString(),
          lastSyncedAt: new Date(),
        },
      })
    } catch { /* non-fatal */ }

    if (expirySec <= nowSec) return { valid: false, reason: 'Session key expired' }
    if (actionType !== undefined && actionType <= 7 && (scopeBitmap & (1 << actionType)) === 0) {
      return { valid: false, reason: 'Action type not in session scope' }
    }
    return { valid: true }
  } catch (err) {
    // RPC failure — allow through; contract will enforce at submission.
    console.warn('[Actions] Session key DB miss + RPC failed (allowing action):', (err as any)?.message)
    return { valid: true }
  }
}

/**
 * natstat: enqueue signed actions into TxQueue
 */
router.post('/', async (req, res) => {
  const reqStart = Date.now()
  const timings: Record<string, number> = {}
  const mark = (label: string) => { timings[label] = Date.now() - reqStart }
  try {
    const { data, domain, types, signature, pendingDepositTxHash, retriedTxQueueId } = req.body

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

    // Limit payload size — action text shouldn't need more than ~100KB
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
    mark('userLookup')

    // Tier 1: no RPC fallback. If the indexer hasn't seen this user yet,
    // 202 immediately — DO NOT insert TxQueue rows for senderIds we haven't
    // validated. The frontend retries with backoff; RawEventsGatherer's Mint
    // listener (and NftTransferWatcher for transfers) populates the row.
    if (!sender?.address) {
      res.setHeader('Retry-After', '3')
      return res.status(202).json({
        error: 'user not yet indexed',
        retryAfterSeconds: 3,
      })
    }

    ownerAddress = sender.address.toLowerCase()

    try {
      // Log the exact shape we're verifying so we can diagnose signature
      // mismatches (e.g. after the string→bytes text-field change). These
      // logs are small and only fire in the signature-verification path.
      console.log('[Actions] verifyTypedData:', {
        chainId: domain?.chainId,
        verifyingContract: domain?.verifyingContract,
        textType: types?.ActionData?.find((f: any) => f.name === 'text')?.type,
        textValue: typeof data?.text === 'string' ? `${data.text.slice(0, 20)}…(${data.text.length}ch)` : typeof data?.text,
        actionType: data?.actionType,
        senderId: data?.senderId,
        cawonce: data?.cawonce,
      })
      recoveredAddress = ethers.verifyTypedData(
        domain,
        { ActionData: types.ActionData },
        data,
        signature
      ).toLowerCase()
    } catch (err: any) {
      console.warn('[Actions] verifyTypedData threw:', err?.shortMessage || err?.message || err)
      return res.status(400).json({ error: 'Invalid signature' })
    }
    mark('verifySig')

    // Decompress smltxt-compressed `bytes text` once for downstream display /
    // storage / URL extraction. The original `data.text` (compressed hex) stays
    // intact — the on-chain submission requires the exact signed bytes.
    const plaintext = decompressActionText(data.text)

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
    mark('sessionCheck')

    // --- Passive auth accumulation ---
    // Now that the signer is verified, create/extend the HTTP session for the token owner.
    // Runs for both wallet-signed actions AND session-key-signed actions — in the
    // session-key case we've just proved on-chain that the signer is a valid delegate
    // for `ownerAddress`, so it's safe to accumulate an HTTP session for the owner.
    // Without this, Quick-Sign-only users never get an HTTP session and see
    // "Verify Wallet" on pages like Notifications despite actively using the app.
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
        // acquired since the session was created (e.g., bought/transferred a new CawProfile).
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
    mark('passiveAuth')

    // Handle hide actions optimistically — hide the caw or delete the recaw immediately
    if ((data.actionType === 7 || data.actionType === 'other') && plaintext?.startsWith('hide:')) {
      try {
        if (plaintext.startsWith('hide:caw:')) {
          const cawonce = parseInt(plaintext.replace('hide:caw:', ''))
          if (!isNaN(cawonce)) {
            await prisma.caw.updateMany({
              where: { userId: data.senderId, cawonce, status: 'SUCCESS' },
              data: { status: 'HIDDEN' }
            })
            console.log(`[Actions] Optimistic hide: user=${data.senderId} cawonce=${cawonce}`)
          }
        } else if (plaintext.startsWith('hide:recaw:')) {
          const parts = plaintext.replace('hide:recaw:', '').split(':')
          const receiverId = parseInt(parts[0])
          const receiverCawonce = parseInt(parts[1])
          if (!isNaN(receiverId) && !isNaN(receiverCawonce)) {
            const originalCaw = await prisma.caw.findFirst({
              where: { userId: receiverId, cawonce: receiverCawonce },
              select: { id: true }
            })
            if (originalCaw) {
              const deleted = await prisma.caw.deleteMany({
                where: { userId: data.senderId, originalCawId: originalCaw.id, action: 'RECAW' }
              })
              if (deleted.count > 0) {
                await prisma.caw.update({
                  where: { id: originalCaw.id },
                  data: { recawCount: { decrement: deleted.count } }
                })
                console.log(`[Actions] Optimistic undo recaw: user=${data.senderId} of caw=${originalCaw.id}`)
              }
            }
          }
        }
      } catch (hideErr) {
        console.error('[Actions] Failed to process optimistic hide:', hideErr)
      }
    }

    // Create optimistic pending state for profile updates
    if (data.actionType === 'other' && plaintext && (plaintext.startsWith('p:') || plaintext.startsWith('profile-update:'))) {
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
    const isQuote = isRecaw && !!plaintext
    if (data.actionType === 0 || data.actionType === 'caw' || isRecaw) { // 0=caw, 3=recaw (plain or quote)
      try {
        // User was already verified above (sender.address is set); no need to
        // call findOrCreateUser again — the redundant lookup was adding ~10ms.

        // Extract image URLs if present
        const imageUrlRegex = /(https?:\/\/[^\s]+\/uploads\/images\/[^\s]+\.(jpg|jpeg|png|gif|webp))/gi
        const imageUrls = plaintext.match(imageUrlRegex) || []
        const videoUrlRegex = /video:(https?:\/\/[^\s]+\/uploads\/videos\/[^\s]+\.(mp4|webm|mov|avi|mkv|ogg|ogv))/gi
        const videoMatches = [...plaintext.matchAll(videoUrlRegex)]
        const videoUrls = videoMatches.map((match: RegExpMatchArray) => match[1])

        // Remove URLs from text content
        let textContent = plaintext
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

        // Optimistically increment counts on the pending caw via CountManager.
        // For replies, do NOT pass originalCawId — replies only affect commentCount
        // (handled separately below), not recawCount on the parent.
        const isReply = !!(originalCawId && !isQuote && !isRecaw)
        if (!existingCaw) {
          try {
            await countManager.onCawCreated(prisma, {
              id: caw.id,
              userId: data.senderId,
              action: isRecaw ? 'RECAW' : 'CAW',
              originalCawId: isReply ? null : (originalCawId || null),
              status: 'PENDING',
            })
          } catch (err) {
            console.error('Failed to optimistically increment counts via CountManager:', err)
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

        // Optimistic Poll creation when the caw text carries a ::poll:...::
        // marker. Same upsert pattern as the indexer in handleCawAction so
        // both paths converge on one row whichever runs first.
        try {
          const parsedPoll = parsePoll(textContent)
          if (parsedPoll) {
            await prisma.poll.upsert({
              where: { cawId: caw.id },
              update: { options: parsedPoll.options },
              create: { cawId: caw.id, options: parsedPoll.options },
            })
          }
        } catch (pollErr) {
          console.error('Failed to create pending poll:', pollErr)
          // Continue — indexer will create the row when the on-chain CAW lands.
        }

        // Create pending Reply record if this is a reply (not a quote/recaw)
        if (originalCawId && caw && !isQuote && !isRecaw) {
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
              await countManager.onReplyCreated(prisma, {
                cawId: originalCawId,
                replyCawId: caw.id,
                pending: true,
              })
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
    mark('optimisticCaw')

    // Debug logging for all actions
    console.log('Received action:', {
      actionType: data.actionType,
      senderId: data.senderId,
      receiverId: data.receiverId,
      receiverCawonce: data.receiverCawonce,
      text: plaintext.substring(0, 50) // First 50 chars for debugging
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
            await countManager.onLikeCreated(prisma, {
              cawId: targetCaw.id,
              userId: data.senderId,
              pending: true,
            })
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
    if ((data.actionType === 7 || data.actionType === 'other') && plaintext.startsWith('tip:')) {
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

          // Parse target caw from plaintext (NOT data.text — that's the
          // smltxt-compressed bytes signed for on-chain submission, and
          // the literal "tip:" prefix only appears after decompression).
          let cawId: number | null = null
          const parts = plaintext.replace('tip:', '').split(':')
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

    // Create / update / delete pending Vote if this is a vote action.
    // Optimistic: the row is written here so the UI can show the vote
    // immediately on refresh; the indexer's handleVoteAction confirms it
    // (pending → false) when the on-chain action lands. On txQueue failure,
    // cleanupOptimisticRows in utils/txQueueFailure.ts removes the pending row.
    if ((data.actionType === 7 || data.actionType === 'other') && plaintext.startsWith('vote:')) {
      try {
        const parsed = parseVoteText(plaintext)
        const pollOwnerTokenId = Number(data.recipients?.[0])
        const targetCawonce = Number(data.receiverCawonce)
        if (parsed && pollOwnerTokenId && Number.isFinite(targetCawonce)) {
          // Find the poll's caw + poll row. If the poll doesn't exist yet
          // locally (race with indexer), skip the optimistic write — the
          // indexer's handleVoteAction will set up state when both rows
          // are present.
          const targetCaw = await prisma.caw.findUnique({
            where: { userId_cawonce: { userId: pollOwnerTokenId, cawonce: targetCawonce } },
            select: { id: true, poll: { select: { id: true } } },
          })
          if (targetCaw?.poll) {
            // Ensure the voter user exists (mirror the tip path's upsert).
            await prisma.user.upsert({
              where: { tokenId: data.senderId },
              update: {},
              create: { id: data.senderId, tokenId: data.senderId, username: `user_${data.senderId}` },
            })

            if (parsed.optionIndex === null) {
              // Optimistic unvote: drop the existing row immediately so the UI
              // reflects "removed" on refresh. If the action fails, the user
              // gets an ACTION_FAILED notification and can retry; the row
              // stays gone in the meantime, which matches what they wanted.
              await prisma.vote.deleteMany({
                where: { pollId: targetCaw.poll.id, voterId: data.senderId },
              })
            } else {
              // Optimistic vote / change-vote. Upsert with pending=true so
              // the indexer can flip it to false later. If the user already
              // had a confirmed vote and is changing, we set pending=true
              // again — failure cleanup will then revert to the prior state
              // when the indexer never confirms. Acceptable: a stuck pending
              // change reverts to "no vote shown" rather than the prior
              // option, which is the safer side of the tradeoff.
              await prisma.vote.upsert({
                where: { pollId_voterId: { pollId: targetCaw.poll.id, voterId: data.senderId } },
                update: { optionIndex: parsed.optionIndex, cawonce: data.cawonce, pending: true },
                create: {
                  pollId: targetCaw.poll.id,
                  voterId: data.senderId,
                  optionIndex: parsed.optionIndex,
                  cawonce: data.cawonce,
                  pending: true,
                },
              })
            }
          }
        }
      } catch (voteErr) {
        console.error('Failed to write pending vote:', voteErr)
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

    // Create the transaction queue entry (or return existing if duplicate signature).
    // If this is a retry, atomically mark the original as 'retried' in the same transaction
    // so we never mark-without-creating or create-without-marking.
    let txQueueEntry
    const parsedRetryId = retriedTxQueueId != null ? Number(retriedTxQueueId) : null
    if (parsedRetryId != null && isNaN(parsedRetryId)) {
      return res.status(400).json({ error: 'Invalid retriedTxQueueId' })
    }

    // Single-action dedup: if this exact signature is already queued (and
    // not part of a batch), return the existing row. signedTx is no longer
    // @unique at the schema level (the batched-sig path reuses one sig
    // across N rows), so we look it up explicitly. batchId IS NULL filters
    // out batch rows where the dedup semantics don't apply.
    const dup = await prisma.txQueue.findFirst({
      where: { signedTx: signature, batchId: null },
      orderBy: { id: 'asc' },
    })
    if (dup) {
      console.log(`Duplicate submission for txQueue ${dup.id}, returning existing entry`)
      return res.json({ txQueueId: dup.id, status: dup.status })
    }

    try {
      txQueueEntry = await prisma.$transaction(async (tx) => {
        if (parsedRetryId != null) {
          const updated = await tx.txQueue.updateMany({
            where: { id: parsedRetryId, status: 'failed' },
            data: { status: 'retried' }
          })
          if (updated.count === 0) {
            throw Object.assign(new Error('Original txQueue is not in failed state — retry already submitted'), { retryConflict: true })
          }
          console.log(`[Actions] Marked TxQueue ${parsedRetryId} as retried`)
        }

        const created = await tx.txQueue.create({
          data: {
            senderId: data.senderId,
            cawonce: data.cawonce,
            payload: { data, domain, types },
            signedTx: signature,
            pendingDepositTxHash: sanitizedPendingDepositTxHash
          }
        })
        return created
      })
    } catch (err: any) {
      if (err.retryConflict) {
        return res.status(409).json({ error: err.message })
      }
      // P2002 = unique constraint violation. Our partial unique index on
      // (senderId, cawonce) for active rows fires when two concurrent
      // submissions try to claim the same cawonce slot — the chain race
      // we expect occasionally with cross-tab / cross-server users. Tell
      // the frontend to invalidate its local cawonce watermark, re-read
      // chain, and re-sign. 409 is the right semantic; the body shape
      // mirrors other typed-error responses.
      if (err?.code === 'P2002') {
        // Tell the client what the highest active cawonce currently is for
        // this sender so it can bump past it on retry. The chain.nextCawonce
        // alone won't help — by definition, our TxQueue has rows for cawonces
        // the chain hasn't yet processed. The client should use
        // max(chain.nextCawonce, suggestedCawonce) on the next attempt.
        const highest = await prisma.txQueue.findFirst({
          where: {
            senderId: data.senderId,
            cawonce: { not: null },
            status: { in: ['pending', 'processing', 'awaiting_indexer', 'waiting_for_deposit'] },
          },
          orderBy: { cawonce: 'desc' },
          select: { cawonce: true },
        })
        const suggestedCawonce = (highest?.cawonce ?? data.cawonce) + 1
        console.log(`[Actions] Cawonce collision: senderId=${data.senderId} cawonce=${data.cawonce} — suggesting ${suggestedCawonce}`)
        return res.status(409).json({
          error: 'cawonce_collision',
          message: 'Another action by this sender is already using this cawonce. Re-read chain and re-sign.',
          senderId: data.senderId,
          cawonce: data.cawonce,
          suggestedCawonce,
        })
      }
      throw err
    }
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

    mark('done')
    const total = Date.now() - reqStart
    if (total > 200) {
      console.log(`[Actions] POST /api/actions took ${total}ms breakdown:`, timings)
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

/**
 * POST /api/actions/batch
 *
 * Fast-path batch endpoint for bulk action submission (e.g. thread posts).
 *
 * All actions in the batch MUST:
 *   - Come from the same senderId
 *   - Be signed by the same signer (the session key address)
 *   - Be covered by an active session key on the token owner's contract state
 *
 * The endpoint does shared work once (user lookup, session key verification,
 * owner address resolution) and then per-action work (signature verify, TxQueue insert).
 * Returns an array of results in the same order as the input.
 */
router.post('/batch', async (req, res) => {
  try {
    const { actions, pendingDepositTxHash, batchSig, domain: batchDomain, types: batchTypes } = req.body

    if (!Array.isArray(actions) || actions.length === 0) {
      return res.status(400).json({ error: 'Expected non-empty actions array' })
    }
    // batchSig path: one ActionBatch signature covers every action in the
    // group. Per-action `signature` fields are not required (and will be
    // ignored if present). When `batchSig` is absent we fall back to the
    // legacy per-action signing path below.
    const useBatchSig = typeof batchSig === 'string' && batchSig.length > 0

    // Per-batch action cap. The contract limits processActions to 256
    // actions per call, but we cap MUCH lower for two reasons:
    //   1. UX: a 64-post thread is already extreme; threads beyond that
    //      benefit nobody.
    //   2. Safety margin against batch-sig truncation: a batch sig commits
    //      to N actions via a single actionsHash, and the validator
    //      cannot split the group across multiple txs without invalidating
    //      the sig (the contract would recover a different signer from a
    //      truncated actionsHash and revert with the misleading "Session
    //      expired or not found" error from the session-key fallback).
    //      Capping well under the contract's 256 + the validator's 120KB
    //      calldata bound makes that overflow essentially unreachable.
    if (actions.length > 64) {
      return res.status(400).json({ error: `Thread too long (${actions.length} posts). Maximum is 64.` })
    }

    // Validate pendingDepositTxHash shape (same rules as single-action endpoint).
    // When present, all resulting TxQueue rows get parked in waiting_for_deposit
    // until the L1→L2 LayerZero propagation lands client authentication.
    let sanitizedPendingDepositTxHash: string | null = null
    if (pendingDepositTxHash !== undefined && pendingDepositTxHash !== null) {
      if (typeof pendingDepositTxHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(pendingDepositTxHash)) {
        return res.status(400).json({ error: 'Invalid pendingDepositTxHash format' })
      }
      sanitizedPendingDepositTxHash = pendingDepositTxHash.toLowerCase()
    }

    // Payload size guard
    const bodySize = JSON.stringify(req.body).length
    if (bodySize > 5 * 1024 * 1024) {
      return res.status(413).json({ error: 'Batch payload too large (max 5MB)' })
    }

    // Validate shape and senderId consistency
    const firstSenderId = actions[0]?.data?.senderId
    if (firstSenderId == null) {
      return res.status(400).json({ error: 'First action missing senderId' })
    }
    for (const a of actions) {
      if (!a?.data) {
        return res.status(400).json({ error: 'Each action must have data' })
      }
      if (!useBatchSig && !a?.signature) {
        return res.status(400).json({ error: 'Each action must have a signature (or pass batchSig instead)' })
      }
      if (a.data.senderId !== firstSenderId) {
        return res.status(400).json({ error: 'All actions must share the same senderId' })
      }
    }

    // Shared lookup: sender. Tier 1: no RPC fallback — 202 if not yet indexed.
    const sender = await prisma.user.findUnique({ where: { tokenId: firstSenderId } })
    if (!sender?.address) {
      res.setHeader('Retry-After', '3')
      return res.status(202).json({
        error: 'user not yet indexed',
        retryAfterSeconds: 3,
      })
    }
    const ownerAddress = sender.address.toLowerCase()

    // Recover the signer.
    //  - batchSig path: verify ONE ActionBatch signature whose actionsHash
    //    commits to the keccak256 of every per-action packed slice. Mirrors
    //    CawActions.processActions's batch path so this API can pre-verify
    //    exactly what the contract will check.
    //  - per-action path: verify the first action's sig and require every
    //    other to recover to the same signer (legacy shape).
    let firstSigner: string
    if (useBatchSig) {
      // Build packed bytes for the whole group, then take per-action keccaks.
      // packActions expects amounts/recipients pre-cleaned, so do that here.
      const sanitizedActions = actions.map((a: any) => {
        const amounts = Array.isArray(a.data.amounts) ? a.data.amounts.map((amt: any) => {
          if (amt === null || amt === undefined || amt === '') return '0'
          const strAmt = String(amt)
          return (strAmt === 'NaN' || isNaN(Number(strAmt))) ? '0' : strAmt
        }) : []
        return {
          actionType: Number(a.data.actionType),
          senderId: Number(a.data.senderId),
          receiverId: Number(a.data.receiverId || 0),
          receiverCawonce: Number(a.data.receiverCawonce || 0),
          clientId: Number(a.data.clientId),
          cawonce: Number(a.data.cawonce),
          recipients: (a.data.recipients || []).map(Number),
          amounts: amounts.map((x: any) => BigInt(x)),
          text: a.data.text || '0x',
        }
      })
      const packed = packActions(sanitizedActions)
      const slices = getPackedActionSlices(packed)
      const perActionHashes: string[] = slices.map(s => ethers.keccak256(s))
      const actionsHash = ethers.keccak256(ethers.solidityPacked(
        Array(perActionHashes.length).fill('bytes32'),
        perActionHashes,
      ))
      const batchMessage = {
        senderId: Number(actions[0].data.senderId),
        firstCawonce: Number(actions[0].data.cawonce),
        actionCount: actions.length,
        actionsHash,
      }
      const batchTypeDef = {
        ActionBatch: [
          { name: 'senderId', type: 'uint32' },
          { name: 'firstCawonce', type: 'uint32' },
          { name: 'actionCount', type: 'uint32' },
          { name: 'actionsHash', type: 'bytes32' },
        ],
      }
      try {
        firstSigner = ethers.verifyTypedData(
          batchDomain,
          batchTypeDef,
          batchMessage,
          batchSig,
        ).toLowerCase()
      } catch (err: any) {
        console.warn('[Actions/batch] verifyTypedData (ActionBatch) threw:', err?.shortMessage || err?.message)
        return res.status(400).json({ error: 'Invalid batch signature' })
      }
    } else {
      try {
        firstSigner = ethers.verifyTypedData(
          actions[0].domain,
          { ActionData: actions[0].types.ActionData },
          actions[0].data,
          actions[0].signature,
        ).toLowerCase()
      } catch {
        return res.status(400).json({ error: 'Invalid signature on first action' })
      }
    }

    // If not owner, check session key once
    const isOwner = firstSigner === ownerAddress
    if (!isOwner) {
      const firstActionType = typeof actions[0].data.actionType === 'number' ? actions[0].data.actionType : undefined
      const sessionCheck = await checkSessionKeyOnChain(ownerAddress, firstSigner, firstActionType)
      if (!sessionCheck.valid) {
        return res.status(403).json({ error: sessionCheck.reason || 'Signer is not authorized' })
      }
    }

    // Allocate a shared batchId for this group so the validator can re-cluster
    // the rows into one sig group when packing the on-chain submission.
    // null on the legacy per-action path keeps existing behaviour.
    const batchId: number | null = useBatchSig ? Date.now() & 0x7fffffff : null

    // Verify every other signature matches the first signer
    // (and that action types are in the session scope if session-signed)
    const results: Array<{ index: number; txQueueId?: number; status?: string; error?: string }> = []
    const rowsToInsert: Array<{ senderId: number; cawonce: number; payload: any; signedTx: string; batchId: number | null }> = []

    for (let i = 0; i < actions.length; i++) {
      const a = actions[i]
      // Sanitize amounts
      if (a.data.amounts && Array.isArray(a.data.amounts)) {
        a.data.amounts = a.data.amounts.map((amt: any) => {
          if (amt === null || amt === undefined || amt === '') return '0'
          const strAmt = String(amt)
          return (strAmt === 'NaN' || isNaN(Number(strAmt))) ? '0' : strAmt
        })
      } else {
        a.data.amounts = []
      }

      if (!useBatchSig) {
        // Verify per-action signature
        try {
          const recovered = ethers.verifyTypedData(
            a.domain,
            { ActionData: a.types.ActionData },
            a.data,
            a.signature
          ).toLowerCase()
          if (recovered !== firstSigner) {
            results.push({ index: i, error: 'Signer mismatch — all actions must share the same signer' })
            continue
          }
        } catch {
          results.push({ index: i, error: 'Invalid signature' })
          continue
        }
      }

      rowsToInsert.push({
        senderId: a.data.senderId,
        cawonce: Number(a.data.cawonce),
        // Use the batch sig as signedTx for every row; the validator looks at
        // batchId to know rows share a sig group, then takes signedTx from
        // one row (any row in the group has the same batch sig).
        payload: { data: a.data, domain: useBatchSig ? batchDomain : a.domain, types: useBatchSig ? batchTypes : a.types },
        signedTx: useBatchSig ? batchSig : a.signature,
        batchId,
      })
      results.push({ index: i }) // placeholder, txQueueId filled after insert
    }

    // No per-sender waiting_for_deposit cap on the batch endpoint — threads
    // posted during LZ propagation are exactly the legitimate use case for
    // pendingDepositTxHash, and callers are already bounded by the 300-action
    // batch cap, 5MB payload cap, ownership check, and same-signer check.

    // Insert TxQueue rows + optimistic Caw/Reply records in a single transaction
    // so the frontend sees the thread in "pending" state immediately and the
    // ActionProcessor can resolve parent cawonces (post 2 → post 1) deterministically.
    if (rowsToInsert.length > 0) {
      // Map index in `actions` array → row in `rowsToInsert`
      const resultIndexToRowIndex = new Map<number, number>()
      let r = 0
      for (let i = 0; i < results.length; i++) {
        if (results[i].error) continue
        resultIndexToRowIndex.set(i, r++)
      }

      let created: any
      try {
        created = await prisma.$transaction(async (tx) => {
        // Step 1: insert all TxQueue rows. Forward pendingDepositTxHash so
        // the validator parks them as waiting_for_deposit until LZ lands
        // client authentication on L2.
        // Insert in chunks of 50 to avoid overwhelming the connection pool
        const txqRows: any[] = []
        for (let chunk = 0; chunk < rowsToInsert.length; chunk += 50) {
          const batch = rowsToInsert.slice(chunk, chunk + 50)
          const created = await Promise.all(
            batch.map(row => tx.txQueue.create({
              data: { ...row, pendingDepositTxHash: sanitizedPendingDepositTxHash }
            }))
          )
          txqRows.push(...created)
        }

        // Step 2: build optimistic Caw records for CAW (0) / RECAW (3) actions.
        // Insert them sequentially so that thread replies (post 2, 3, ... → post 1)
        // can look up their parent within this same transaction.
        const cawByUserCawonce = new Map<string, number>() // "userId:cawonce" → cawId

        for (let i = 0; i < actions.length; i++) {
          if (!resultIndexToRowIndex.has(i)) continue
          const a = actions[i]
          const d = a.data
          const actionType = d.actionType
          const isCaw = actionType === 0 || actionType === 'caw'
          const isRecaw = actionType === 3 || actionType === 'recaw'
          if (!isCaw && !isRecaw) continue

          // Strip media URLs from text content (same as single-action path).
          // d.text is smltxt-compressed hex — decompress for display/URL parsing.
          const dPlain = decompressActionText(d.text)
          const isQuote = isRecaw && !!dPlain
          const imageUrlRegex = /(https?:\/\/[^\s]+\/uploads\/images\/[^\s]+\.(jpg|jpeg|png|gif|webp))/gi
          const imageUrls = dPlain.match(imageUrlRegex) || []
          const videoUrlRegex = /video:(https?:\/\/[^\s]+\/uploads\/videos\/[^\s]+\.(mp4|webm|mov|avi|mkv|ogg|ogv))/gi
          const videoMatches = [...dPlain.matchAll(videoUrlRegex)]
          const videoUrls = videoMatches.map((m: RegExpMatchArray) => m[1])
          let textContent = dPlain
          imageUrls.forEach((url: string) => { textContent = textContent.replace(url, '').trim() })
          videoMatches.forEach((m: RegExpMatchArray) => { textContent = textContent.replace(m[0], '').trim() })
          textContent = textContent.replace(/\n{3,}/g, '\n\n').trim()

          // Resolve parent cawonce → cawId. Check this-batch map first, then DB.
          let originalCawId: number | undefined
          if (d.receiverId != null && d.receiverCawonce != null) {
            const key = `${d.receiverId}:${d.receiverCawonce}`
            originalCawId = cawByUserCawonce.get(key)
            if (!originalCawId) {
              const parent = await tx.caw.findFirst({
                where: { userId: d.receiverId, cawonce: d.receiverCawonce },
                select: { id: true },
              })
              if (parent) originalCawId = parent.id
            }
          }

          // Upsert the pending Caw
          const caw = await tx.caw.upsert({
            where: { userId_cawonce: { userId: d.senderId, cawonce: d.cawonce } },
            update: {
              status: 'PENDING',
              originalCawId: originalCawId || null,
              updatedAt: new Date(),
            },
            create: {
              userId: d.senderId,
              cawonce: d.cawonce,
              content: textContent,
              action: isRecaw ? 'RECAW' : 'CAW',
              status: 'PENDING',
              originalCawId: originalCawId || null,
              imageData: imageUrls.length > 0 ? `urls:${imageUrls.join('|||')}` : null,
              hasImage: imageUrls.length > 0,
              videoData: videoUrls.length > 0 ? videoUrls.join('|||') : null,
              hasVideo: videoUrls.length > 0,
            },
          })
          cawByUserCawonce.set(`${d.senderId}:${d.cawonce}`, caw.id)

          // Create pending Reply record (CAW replies only — not RECAW quotes)
          if (originalCawId && isCaw && !isQuote) {
            try {
              const existing = await tx.reply.findUnique({
                where: {
                  userId_cawId_replyCawId: {
                    userId: d.senderId,
                    cawId: originalCawId,
                    replyCawId: caw.id,
                  },
                },
              })
              await tx.reply.upsert({
                where: {
                  userId_cawId_replyCawId: {
                    userId: d.senderId,
                    cawId: originalCawId,
                    replyCawId: caw.id,
                  },
                },
                update: { pending: true },
                create: {
                  userId: d.senderId,
                  cawId: originalCawId,
                  replyCawId: caw.id,
                  pending: true,
                },
              })
              if (!existing) {
                await countManager.onReplyCreated(tx, {
                  cawId: originalCawId,
                  replyCawId: caw.id,
                  pending: true,
                })
              }
            } catch (replyErr: any) {
              console.warn(`[Actions/batch] Reply record failed for ${d.senderId}:${d.cawonce}:`, replyErr.message)
            }
          }
        }

        return txqRows
      })
      } catch (err: any) {
        // P2002 = unique constraint violation on (senderId, cawonce)
        // active partial index — one or more cawonces in this batch
        // collide with another in-flight submission. Rejecting the whole
        // batch is the correct (and simplest) call: thread cawonces are
        // contiguous, so partial success would leave a sequence-gap that
        // breaks reply-grouping anyway. The frontend re-reads chain,
        // re-allocates the contiguous block, re-signs, and resubmits.
        if (err?.code === 'P2002') {
          // Tell the client where to start its next batch: highest active
          // cawonce + 1. Same reasoning as the single-action path —
          // chain.nextCawonce alone is insufficient because the TxQueue
          // has rows the chain hasn't seen yet.
          const highest = await prisma.txQueue.findFirst({
            where: {
              senderId: firstSenderId,
              cawonce: { not: null },
              status: { in: ['pending', 'processing', 'awaiting_indexer', 'waiting_for_deposit'] },
            },
            orderBy: { cawonce: 'desc' },
            select: { cawonce: true },
          })
          const suggestedCawonce = (highest?.cawonce ?? 0) + 1
          console.log(`[Actions/batch] Cawonce collision — suggesting start cawonce=${suggestedCawonce}`)
          return res.status(409).json({
            error: 'cawonce_collision',
            message: 'One or more actions in this batch are already using their cawonce. Re-read chain and re-sign.',
            suggestedCawonce,
          })
        }
        throw err
      }

      // Map created TxQueue IDs back to results
      let insertIdx = 0
      for (let i = 0; i < results.length; i++) {
        if (results[i].error) continue
        results[i].txQueueId = created[insertIdx].id
        results[i].status = 'queued'
        insertIdx++
      }
    }

    console.log(`[Actions/batch] Processed ${actions.length} actions for sender ${firstSenderId}: ${rowsToInsert.length} queued, ${actions.length - rowsToInsert.length} rejected`)

    res.status(201).json({ results })
  } catch (err: any) {
    console.error('POST /api/actions/batch error', err)
    res.status(500).json({ error: err.message || 'Internal error' })
  }
})

export default router



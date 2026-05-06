import { Router, Request, Response } from 'express'
import { prisma } from '../../prismaClient'
import dmService from '../../services/DmService'
import dmWebSocketService from '../../services/DmService/websocket'
import { requireAuth } from '../middleware/auth'
import { isBlockedEitherDirection, getBlockedUserIds } from '../shared/blockUtils'
import {
  relayDmToPeers,
  relayDmIdentityToPeers,
  canonicalizeIdentityEnvelope,
} from '../../services/DmRelayService'
import { recoverAddressFromCanonical } from '../../services/InstanceRegistryService/envelopeCrypto'
import { getPeers } from '../../services/InstanceRegistryService'
import { checkDmRate } from '../dmRateLimit'
import crypto from 'crypto'

const CLIENT_ID = (() => {
  const raw = process.env.CLIENT_ID
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('dm route: CLIENT_ID is required (set it in client/.env)')
  }
  return n
})()

const router = Router()

// Register DM public key
router.post('/identity',
  requireAuth({ field: 'userId', verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const { userId, walletAddress, publicKey } = req.body
      if (!userId || !walletAddress || !publicKey) {
        return res.status(400).json({ error: 'userId, walletAddress, and publicKey are required' })
      }

      // Verify the wallet address matches the token owner
      const user = await prisma.user.findUnique({ where: { tokenId: Number(userId) }, select: { address: true } })
      if (!user || user.address.toLowerCase() !== walletAddress.toLowerCase()) {
        return res.status(403).json({ error: 'Wallet address does not match the owner of this token' })
      }

      const identity = await dmService.registerIdentity(Number(userId), walletAddress, publicKey)

      // Fan out to peer instances so other nodes' DmIdentity tables stay
      // in sync. Mirrors are otherwise blind to a user's DM-enable until
      // that user happens to interact with the mirror — UX cost: search
      // results show "DMs not enabled" on every other mirror, and the
      // first cross-node message can't be encrypted because the sender's
      // home node doesn't know the recipient's pubkey. Fire-and-forget;
      // failures don't block local registration.
      relayDmIdentityToPeers({
        userId: Number(userId),
        walletAddress,
        publicKey,
      }).catch(err => {
        console.warn('[DM] identity relay failed (continuing):', err?.message || err)
      })

      return res.json(identity)
    } catch (error: any) {
      console.error('POST /api/dm/identity error:', error)
      return res.status(500).json({ error: error.message })
    }
  }
)

// POST /api/dm/identity/relay — peer-to-peer sync of DmIdentity rows.
// Mirrors the dm-relay.ts pattern: source instance signs the envelope
// with its validator key, receiver verifies against the registered
// validatorAddress in CawClientManager. The relayed publicKey is then
// upserted locally so this node's lookup endpoints see the same data
// every other peer sees.
//
// MUST be registered before /identity/:userId so Express's declaration-
// order matching doesn't capture "relay" as a userId.
router.post('/identity/relay', async (req: Request, res: Response) => {
  try {
    const { userId, walletAddress, publicKey, timestamp, sourceInstanceId, signature } = req.body
    if (
      userId == null || !walletAddress || !publicKey ||
      !timestamp || sourceInstanceId == null || !signature
    ) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    // Replay window. Same ±5min as the message relay.
    const age = Date.now() - Number(timestamp)
    if (age > 5 * 60 * 1000 || age < -60 * 1000) {
      return res.status(400).json({ error: 'Identity timestamp out of range' })
    }

    // Source instance must be active in our registry cache.
    const peers = getPeers(CLIENT_ID)
    const source = peers.find(p => p.instanceId === Number(sourceInstanceId))
    if (!source || !source.active) {
      return res.status(403).json({ error: 'Unknown or inactive source instance' })
    }

    // Recover the signing address; must match the source's validator.
    let recoveredAddr: string
    try {
      recoveredAddr = await recoverAddressFromCanonical(
        canonicalizeIdentityEnvelope({
          userId: Number(userId),
          walletAddress,
          publicKey,
          timestamp: Number(timestamp),
          sourceInstanceId: Number(sourceInstanceId),
        }),
        signature,
      )
    } catch (err: any) {
      return res.status(403).json({ error: 'Signature verification failed', detail: err.message })
    }
    if (recoveredAddr.toLowerCase() !== source.validatorAddress.toLowerCase()) {
      return res.status(403).json({ error: 'Signature does not match source instance validator' })
    }

    // Wallet binding: the relayed walletAddress must match this node's
    // User.address[userId]. Without the check, a malicious node could
    // assert "user 42's wallet is 0xATTACKER" and overwrite the local
    // pubkey — receivers would then encrypt to a key the attacker
    // generated, breaking 42's DMs. If the local User row doesn't
    // exist yet (indexer lag), accept tentatively — the indexer will
    // populate User.address from on-chain Transfer events shortly,
    // and any subsequent re-relay will face the strict check.
    const localUser = await prisma.user.findUnique({
      where: { tokenId: Number(userId) },
      select: { address: true },
    })
    if (localUser && localUser.address && localUser.address.toLowerCase() !== walletAddress.toLowerCase()) {
      return res.status(403).json({
        error: 'Wallet address mismatch with local User row',
        userId: Number(userId),
      })
    }

    await dmService.registerIdentity(Number(userId), walletAddress, publicKey)
    return res.json({ status: 'synced', userId: Number(userId) })
  } catch (error: any) {
    console.error('[DM Identity Relay] Error:', error.message)
    return res.status(500).json({ error: 'Identity relay failed' })
  }
})

// GET /api/dm/identity/batch?userIds=1,2,3
// Read-only bulk lookup of DM identities — replaces the per-user
// /identity/:userId fan-out from the Messages page (recent follows + new-
// message search). Capped at 100 ids per request, so the comma-joined
// querystring stays comfortably under typical URL limits.
//
// IMPORTANT: this route MUST be registered before /identity/:userId.
// Express matches in declaration order, so registering :userId first
// would let it swallow "/identity/batch" with userId = "batch" and the
// batch endpoint would silently 400 with "Invalid userId" forever.
router.get('/identity/batch', async (req: Request, res: Response) => {
  try {
    const raw = String(req.query.userIds || '')
    if (!raw) {
      return res.status(400).json({ error: 'userIds query parameter required' })
    }
    const ids = [...new Set(
      raw.split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0)
    )].slice(0, 100)
    if (ids.length === 0) {
      return res.json({ identities: {} })
    }
    const rows = await dmService.getPublicKeysBatch(ids)
    // Shape: { [userId]: { hasIdentity, publicKey } }. Missing rows are
    // still included so callers can distinguish "no identity" from "not
    // asked about" without inspecting the request.
    const identities: Record<number, { hasIdentity: boolean; publicKey: string | null }> = {}
    for (const id of ids) {
      const publicKey = rows.get(id) ?? null
      identities[id] = { hasIdentity: publicKey !== null, publicKey }
    }
    return res.json({ identities })
  } catch (error: any) {
    console.error('GET /api/dm/identity/batch error:', error)
    return res.status(500).json({ error: error.message })
  }
})

// Get a user's public key (public endpoint, no auth)
router.get('/identity/:userId', async (req: Request, res: Response) => {
  try {
    const userId = Number(req.params.userId)
    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid userId' })
    }

    const publicKey = await dmService.getPublicKey(userId)
    const hasIdentity = publicKey !== null
    return res.json({ userId, publicKey, hasIdentity })
  } catch (error: any) {
    console.error('GET /api/dm/identity/:userId error:', error)
    return res.status(500).json({ error: error.message })
  }
})

// Get or create a DM conversation
router.post('/conversations',
  requireAuth({ field: 'userId', verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const { userId, peerUserId } = req.body
      if (!userId || !peerUserId) {
        return res.status(400).json({ error: 'userId and peerUserId are required' })
      }
      if (userId === peerUserId) {
        return res.status(400).json({ error: 'Cannot create conversation with yourself' })
      }

      // Verify peer has a DM identity
      const peerIdentity = await prisma.dmIdentity.findUnique({
        where: { userId: Number(peerUserId) },
        include: { user: { select: { username: true, displayName: true, avatarUrl: true, defaultAvatarId: true, image: true, tokenId: true } } }
      })
      if (!peerIdentity) {
        return res.status(400).json({ error: 'Peer has not enabled DMs' })
      }

      // Check DM privacy settings
      const privacy = peerIdentity.dmPrivacy // EVERYONE, FOLLOWERS, FOLLOWING
      if (privacy !== 'EVERYONE') {
        const senderId = Number(userId)
        const recipientId = Number(peerUserId)

        if (privacy === 'FOLLOWING') {
          // Recipient only accepts from people they follow
          const recipientFollowsSender = await prisma.follow.findUnique({
            where: { followerId_followingId: { followerId: recipientId, followingId: senderId } }
          })
          if (!recipientFollowsSender || recipientFollowsSender.action !== 'FOLLOW' || recipientFollowsSender.status !== 'SUCCESS') {
            return res.status(403).json({
              error: 'DM_PRIVACY',
              reason: 'following',
              message: `@${peerIdentity.user.username} only accepts messages from users they follow.`,
              peer: peerIdentity.user
            })
          }
        } else if (privacy === 'FOLLOWERS') {
          // Recipient accepts from followers + people they follow
          const [senderFollowsRecipient, recipientFollowsSender] = await Promise.all([
            prisma.follow.findUnique({
              where: { followerId_followingId: { followerId: senderId, followingId: recipientId } }
            }),
            prisma.follow.findUnique({
              where: { followerId_followingId: { followerId: recipientId, followingId: senderId } }
            })
          ])
          const senderIsFollower = senderFollowsRecipient?.action === 'FOLLOW' && senderFollowsRecipient?.status === 'SUCCESS'
          const recipientFollows = recipientFollowsSender?.action === 'FOLLOW' && recipientFollowsSender?.status === 'SUCCESS'
          if (!senderIsFollower && !recipientFollows) {
            return res.status(403).json({
              error: 'DM_PRIVACY',
              reason: 'followers',
              message: `@${peerIdentity.user.username} only accepts messages from their followers.`,
              peer: peerIdentity.user
            })
          }
        }
      }

      const conversation = await dmService.getOrCreateConversation(Number(userId), Number(peerUserId))

      // Notify peer of new conversation via WebSocket
      dmWebSocketService.notifyNewConversation(Number(peerUserId), conversation)

      return res.json(conversation)
    } catch (error: any) {
      console.error('POST /api/dm/conversations error:', error)
      return res.status(500).json({ error: error.message })
    }
  }
)

// List conversations for a user
router.get('/conversations',
  requireAuth({ lookup: async (req) => {
    const userId = req.query.userId
    return userId ? Number(userId) : undefined
  }, verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const userId = Number(req.query.userId)
      if (isNaN(userId)) {
        return res.status(400).json({ error: 'userId query parameter is required' })
      }

      const limit = Math.min(Number(req.query.limit) || 50, 100)
      const offset = Number(req.query.offset) || 0
      const inboxParam = String(req.query.inbox || 'main')
      const inbox: 'main' | 'requests' | 'all' =
        inboxParam === 'requests' || inboxParam === 'all' ? inboxParam : 'main'

      const { conversations, hasMore } = await dmService.getConversations(userId, limit, offset, inbox)

      // Filter out conversations with blocked users
      const blockedIds = await getBlockedUserIds(userId)
      const filtered = blockedIds.length > 0
        ? conversations.filter((c: any) =>
            !c.participants?.some((p: any) => p.userId !== userId && blockedIds.includes(p.userId))
          )
        : conversations

      return res.json({ conversations: filtered, hasMore })
    } catch (error: any) {
      console.error('GET /api/dm/conversations error:', error)
      return res.status(500).json({ error: error.message })
    }
  }
)

// Request-inbox badge count. Single integer for the tab indicator.
router.get('/conversations/request-count',
  requireAuth({ lookup: async (req) => {
    const userId = req.query.userId
    return userId ? Number(userId) : undefined
  }, verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const userId = Number(req.query.userId)
      if (isNaN(userId)) {
        return res.status(400).json({ error: 'userId query parameter is required' })
      }
      const count = await dmService.getRequestCount(userId)
      return res.json({ count })
    } catch (error: any) {
      console.error('GET /api/dm/conversations/request-count error:', error)
      return res.status(500).json({ error: error.message })
    }
  }
)

// Flip a REQUEST conversation to ACCEPTED on the caller's side. No-op
// if already accepted (e.g. the user already replied, which auto-
// accepts via the send path). Idempotent.
router.post('/conversations/:id/accept',
  requireAuth({ field: 'userId', verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const conversationId = String(req.params.id)
      const userId = Number(req.body.userId)
      if (!conversationId || !Number.isInteger(userId)) {
        return res.status(400).json({ error: 'conversationId and userId required' })
      }
      await dmService.acceptConversation(conversationId, userId)
      return res.json({ status: 'accepted', conversationId })
    } catch (error: any) {
      console.error('POST /api/dm/conversations/:id/accept error:', error)
      return res.status(500).json({ error: error.message })
    }
  }
)

// Send an encrypted message
router.post('/messages',
  requireAuth({ field: 'senderId', verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const { conversationId, senderId, encryptedPayload, contentType, replyToMessageId } = req.body
      if (!conversationId || !senderId || !encryptedPayload) {
        return res.status(400).json({ error: 'conversationId, senderId, and encryptedPayload are required' })
      }

      // Check if either user has blocked the other
      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { participants: true }
      })
      if (!conv) return res.status(404).json({ error: 'Conversation not found' })
      const peer = conv.participants.find((p: any) => p.userId !== Number(senderId))
      console.log(`[DM] POST /messages: senderId=${senderId}, peer=${peer?.userId || 'none'}`)

      const isShadowBlocked = peer ? await isBlockedEitherDirection(Number(senderId), peer.userId) : false
      console.log(`[DM] Shadow block check: ${isShadowBlocked}`)

      if (isShadowBlocked) {
        console.log(`[DM] Shadow blocking message from ${senderId} to ${peer?.userId}`)
        const message = await prisma.message.create({
          data: {
            conversationId,
            senderId: Number(senderId),
            encryptedPayload,
            contentType: contentType || 'text',
            shadowBlocked: true,
            replyToMessageId: replyToMessageId || null,
          }
        })
        return res.json(message)
      }

      // Check DM privacy settings of the recipient
      if (peer) {
        const peerIdentity = await prisma.dmIdentity.findUnique({
          where: { userId: peer.userId },
          include: { user: { select: { username: true, displayName: true, avatarUrl: true, defaultAvatarId: true, image: true, tokenId: true } } }
        })

        const privacy = peerIdentity?.dmPrivacy || 'EVERYONE'
        console.log(`[DM] Privacy check: peer=${peer.userId}, dmPrivacy=${privacy}, sender=${senderId}`)

        if (peerIdentity && privacy !== 'EVERYONE') {
          const sid = Number(senderId)
          const rid = peer.userId

          let allowed = false
          if (privacy === 'FOLLOWING') {
            const recipientFollowsSender = await prisma.follow.findUnique({
              where: { followerId_followingId: { followerId: rid, followingId: sid } }
            })
            allowed = !!(recipientFollowsSender?.action === 'FOLLOW' && recipientFollowsSender?.status === 'SUCCESS')
            console.log(`[DM] FOLLOWING check: recipient ${rid} follows sender ${sid}? ${allowed}`, recipientFollowsSender)
          } else if (privacy === 'FOLLOWERS') {
            const [senderFollowsRecipient, recipientFollowsSender] = await Promise.all([
              prisma.follow.findUnique({
                where: { followerId_followingId: { followerId: sid, followingId: rid } }
              }),
              prisma.follow.findUnique({
                where: { followerId_followingId: { followerId: rid, followingId: sid } }
              })
            ])
            const senderIsFollower = !!(senderFollowsRecipient?.action === 'FOLLOW' && senderFollowsRecipient?.status === 'SUCCESS')
            const recipientFollows = !!(recipientFollowsSender?.action === 'FOLLOW' && recipientFollowsSender?.status === 'SUCCESS')
            allowed = senderIsFollower || recipientFollows
            console.log(`[DM] FOLLOWERS check: sender ${sid} follows recipient ${rid}? ${senderIsFollower}, recipient follows sender? ${recipientFollows}, allowed=${allowed}`)
          }

          if (!allowed) {
            const reason = privacy === 'FOLLOWING' ? 'following' : 'followers'
            console.log(`[DM] Privacy DENIED: ${reason} — returning 403`)
            return res.status(403).json({
              error: 'DM_PRIVACY',
              reason,
              message: reason === 'following'
                ? `@${peerIdentity.user.username} only accepts messages from users they follow.`
                : `@${peerIdentity.user.username} only accepts messages from their followers.`,
              peer: peerIdentity.user
            })
          }
          console.log(`[DM] Privacy ALLOWED`)
        } else {
          console.log(`[DM] Privacy check skipped: ${privacy === 'EVERYONE' ? 'set to EVERYONE' : 'no identity found'}`)
        }
      } else {
        console.log(`[DM] No peer found in conversation — skipping privacy check`)
      }

      // Per-(sender, recipient) anti-spam bucket. Applies on the
      // allowed-to-send path only — shadow-blocked sends short-circuit
      // above and don't consume budget. Cold senders (no consent
      // baseline) get 10/h; warm (replied-to / mutual-follow) get 100/h.
      // Failure mode is fail-open if Redis is unreachable; the
      // per-source-IP cap on /api/dm/relay still applies on the
      // receiver side.
      if (peer) {
        const rate = await checkDmRate(Number(senderId), peer.userId)
        if (!rate.allowed) {
          console.log(`[DM] Rate limit hit: ${senderId} → ${peer.userId} (warm=${rate.warm}, limit=${rate.limit})`)
          res.set('Retry-After', String(rate.resetSeconds))
          return res.status(429).json({
            error: 'DM_RATE_LIMIT',
            limit: rate.limit,
            warm: rate.warm,
            resetSeconds: rate.resetSeconds,
            message: rate.warm
              ? `You're sending DMs too quickly. Try again in ${Math.ceil(rate.resetSeconds / 60)} minutes.`
              : `New conversations are rate-limited to ${rate.limit}/hour. Reach out via a public reply if it's urgent.`,
          })
        }
      }

      // Generate a relayId up front so the same id can be used both for
      // the local row AND the cross-instance relay. If the relay loops
      // back (peer fans out, our /api/dm/relay sees the same id), the
      // unique partial index dedupes cleanly.
      const relayId = crypto.randomUUID()

      const message = await dmService.sendMessage({
        conversationId,
        senderId: Number(senderId),
        encryptedPayload,
        contentType,
        replyToMessageId,
        relayId,
      })

      // Implicit accept-on-reply. When the sender's own participant.status
      // is REQUEST, the act of sending a message is consent — flip their
      // side to ACCEPTED so the conversation moves out of their Requests
      // tab on next refetch. No-op when already ACCEPTED.
      dmService.acceptConversation(conversationId, Number(senderId)).catch(err => {
        console.warn('[DM] auto-accept on reply failed (non-fatal):', err?.message || err)
      })

      // Broadcast via WebSocket
      dmWebSocketService.broadcastMessage(message)

      // Cross-instance relay. Fire-and-forget; relay failures must not
      // block the user's send — the message is already persisted locally
      // and the WebSocket already pushed it to anyone connected here.
      // Skipped silently on solo nodes (no peers, or no validator key).
      if (peer) {
        relayDmToPeers({
          encryptedPayload,
          senderId: Number(senderId),
          recipientId: peer.userId,
          conversationId,
          contentType: contentType || 'text',
          relayId,
        }).catch(err => {
          console.warn('[DM] relay failed (continuing):', err?.message || err)
        })
      }

      return res.json(message)
    } catch (error: any) {
      console.error('POST /api/dm/messages error:', error)
      return res.status(500).json({ error: error.message })
    }
  }
)

// Get messages for a conversation
router.get('/conversations/:id/messages',
  requireAuth({ lookup: async (req) => {
    const userId = req.query.userId
    return userId ? Number(userId) : undefined
  }, verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const conversationId = req.params.id
      const userId = Number(req.query.userId)
      const limit = Number(req.query.limit) || 50
      const before = req.query.before as string | undefined

      if (isNaN(userId)) {
        return res.status(400).json({ error: 'userId query parameter is required' })
      }

      const result = await dmService.getMessages(conversationId, userId, limit, before)
      return res.json({ messages: result.messages, peerLastReadAt: result.peerLastReadAt })
    } catch (error: any) {
      console.error('GET /api/dm/conversations/:id/messages error:', error)
      return res.status(500).json({ error: error.message })
    }
  }
)

// Mark messages as read
router.post('/messages/read',
  requireAuth({ field: 'userId', verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const { messageIds, userId } = req.body
      if (!messageIds?.length || !userId) {
        return res.status(400).json({ error: 'messageIds and userId are required' })
      }

      const result = await dmService.markRead(messageIds, Number(userId))
      return res.json(result)
    } catch (error: any) {
      console.error('POST /api/dm/messages/read error:', error)
      return res.status(500).json({ error: error.message })
    }
  }
)

const EDIT_WINDOW_MS = 15 * 60 * 1000   // 15 minutes
const DELETE_WINDOW_MS = 5 * 60 * 1000  // 5 minutes

// Edit a message (within 15 minutes, sender only)
router.patch('/messages/:messageId',
  requireAuth({ lookup: async (req) => {
    const msg = await prisma.message.findUnique({ where: { id: req.params.messageId }, select: { senderId: true } })
    return msg?.senderId
  }, verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const { messageId } = req.params
      const { encryptedPayload, previousEncryptedPayload } = req.body

      if (!encryptedPayload) {
        return res.status(400).json({ error: 'encryptedPayload is required' })
      }

      const message = await prisma.message.findUnique({ where: { id: messageId } })
      if (!message) return res.status(404).json({ error: 'Message not found' })
      if (message.contentType === 'deleted') return res.status(400).json({ error: 'Cannot edit a deleted message' })

      // Check 15-minute window
      const elapsed = Date.now() - message.createdAt.getTime()
      if (elapsed > EDIT_WINDOW_MS) {
        return res.status(403).json({ error: 'Edit window has expired (15 minutes)' })
      }

      // Build edit history — append the previous version
      let history: string[] = []
      if (message.editHistory) {
        try { history = JSON.parse(message.editHistory) } catch {}
      }
      // Store the previous encrypted payload with timestamp
      history.push(JSON.stringify({
        encryptedPayload: previousEncryptedPayload || message.encryptedPayload,
        editedAt: new Date().toISOString()
      }))

      const updated = await prisma.message.update({
        where: { id: messageId },
        data: {
          encryptedPayload,
          editHistory: JSON.stringify(history),
        }
      })

      // Notify via WebSocket
      dmWebSocketService.notifyMessageEdited(message.conversationId, messageId, message.senderId)

      return res.json({ success: true, message: updated })
    } catch (error: any) {
      console.error('PATCH /api/dm/messages/:messageId error:', error)
      return res.status(500).json({ error: error.message })
    }
  }
)

// Delete for me — hide message from requesting user
router.post('/messages/:messageId/hide',
  requireAuth({ lookup: async (req) => {
    // Allow either participant to hide
    const userId = Number(req.body.userId)
    if (!userId) return undefined
    const msg = await prisma.message.findUnique({
      where: { id: req.params.messageId },
      include: { conversation: { include: { participants: true } } }
    })
    const isParticipant = msg?.conversation.participants.some(p => p.userId === userId)
    return isParticipant ? userId : undefined
  }, verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const { messageId } = req.params
      const { userId } = req.body

      if (!userId) return res.status(400).json({ error: 'userId is required' })

      const message = await prisma.message.findUnique({ where: { id: messageId } })
      if (!message) return res.status(404).json({ error: 'Message not found' })

      await prisma.messageDeletion.upsert({
        where: { messageId_userId: { messageId, userId: Number(userId) } },
        update: {},
        create: { messageId, userId: Number(userId) }
      })

      return res.json({ success: true })
    } catch (error: any) {
      console.error('POST /api/dm/messages/:messageId/hide error:', error)
      return res.status(500).json({ error: error.message })
    }
  }
)

// Delete for everyone — tombstone message (within 5 minutes, sender only)
router.delete('/messages/:messageId',
  requireAuth({ lookup: async (req) => {
    const msg = await prisma.message.findUnique({ where: { id: req.params.messageId }, select: { senderId: true } })
    return msg?.senderId
  }, verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const { messageId } = req.params

      const message = await prisma.message.findUnique({ where: { id: messageId } })
      if (!message) return res.status(404).json({ error: 'Message not found' })
      if (message.contentType === 'deleted') return res.status(400).json({ error: 'Already deleted' })

      // Check 5-minute window
      const elapsed = Date.now() - message.createdAt.getTime()
      if (elapsed > DELETE_WINDOW_MS) {
        return res.status(403).json({ error: 'Delete window has expired (5 minutes)' })
      }

      // Tombstone: wipe payload and edit history, set contentType to deleted
      await prisma.message.update({
        where: { id: messageId },
        data: {
          encryptedPayload: null,
          editHistory: null,
          contentType: 'deleted',
        }
      })

      // Notify via WebSocket
      dmWebSocketService.notifyMessageDeleted(message.conversationId, messageId, message.senderId)

      return res.json({ success: true })
    } catch (error: any) {
      console.error('DELETE /api/dm/messages/:messageId error:', error)
      return res.status(500).json({ error: error.message })
    }
  }
)

// Toggle a reaction on a DM. Idempotent toggle — same body twice removes,
// re-adds. Caller must be a participant in the message's conversation;
// the auth lookup verifies that.
router.post('/messages/:messageId/reactions',
  requireAuth({ lookup: async (req) => {
    const userId = Number(req.body.userId)
    if (!userId) return undefined
    const msg = await prisma.message.findUnique({
      where: { id: req.params.messageId },
      include: { conversation: { include: { participants: true } } },
    })
    const isParticipant = msg?.conversation.participants.some(p => p.userId === userId)
    return isParticipant ? userId : undefined
  }, verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const { messageId } = req.params
      const { userId, emoji } = req.body
      if (!userId) return res.status(400).json({ error: 'userId is required' })
      if (!emoji || typeof emoji !== 'string') {
        return res.status(400).json({ error: 'emoji is required' })
      }
      // Length cap — emojis with skin-tone modifiers + ZWJ sequences can
      // be ~14 chars; 32 covers everything sensible.
      if (emoji.length > 32) return res.status(400).json({ error: 'emoji too long' })

      const result = await dmService.toggleReaction(messageId, Number(userId), emoji)

      // Broadcast to the conversation room — includes the actor so their
      // own UI updates from the same code path other peers use.
      dmWebSocketService.notifyReactionToggled(result.conversationId, {
        messageId,
        userId: Number(userId),
        emoji,
        added: result.added,
      })

      return res.json({ added: result.added })
    } catch (error: any) {
      console.error('POST /api/dm/messages/:messageId/reactions error:', error)
      return res.status(500).json({ error: error.message })
    }
  }
)

// Get DM settings for a user
router.get('/settings',
  async (req: any, res: any) => {
    try {
      const userId = Number(req.query.userId)
      if (!userId) return res.status(400).json({ error: 'userId is required' })

      const identity = await prisma.dmIdentity.findUnique({
        where: { userId },
        select: { dmPrivacy: true, defaultDmReactions: true }
      })

      res.json({
        dmPrivacy: identity?.dmPrivacy || 'EVERYONE',
        defaultDmReactions: identity?.defaultDmReactions ?? [],
      })
    } catch (error: any) {
      console.error('GET /api/dm/settings error:', error)
      res.status(500).json({ error: error.message })
    }
  }
)

// Update DM settings. Both fields are optional — the client sends only
// what changed, so toggling reactions doesn't require re-sending privacy
// (and vice versa).
router.put('/settings',
  requireAuth({ field: 'userId', verifyOwnership: true }),
  async (req: any, res: any) => {
    try {
      const { userId, dmPrivacy, defaultDmReactions } = req.body
      if (!userId) return res.status(400).json({ error: 'userId is required' })

      const update: any = {}

      if (dmPrivacy !== undefined) {
        const validValues = ['EVERYONE', 'FOLLOWERS', 'FOLLOWING']
        if (!validValues.includes(dmPrivacy)) {
          return res.status(400).json({ error: `dmPrivacy must be one of: ${validValues.join(', ')}` })
        }
        update.dmPrivacy = dmPrivacy
      }

      if (defaultDmReactions !== undefined) {
        if (!Array.isArray(defaultDmReactions) || defaultDmReactions.some((e: any) => typeof e !== 'string')) {
          return res.status(400).json({ error: 'defaultDmReactions must be an array of strings' })
        }
        // Cap to 10 to mirror the service-layer clamp.
        update.defaultDmReactions = defaultDmReactions.slice(0, 10)
      }

      if (Object.keys(update).length === 0) {
        return res.status(400).json({ error: 'no settings provided' })
      }

      const updated = await prisma.dmIdentity.update({
        where: { userId: Number(userId) },
        data: update,
        select: { dmPrivacy: true, defaultDmReactions: true },
      })

      res.json({ success: true, ...updated })
    } catch (error: any) {
      console.error('PUT /api/dm/settings error:', error)
      res.status(500).json({ error: error.message })
    }
  }
)

export default router

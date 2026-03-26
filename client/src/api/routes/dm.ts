import { Router, Request, Response } from 'express'
import { PrismaClient } from '@prisma/client'
import dmService from '../../services/DmService'
import dmWebSocketService from '../../services/DmService/websocket'
import { requireAuth } from '../middleware/auth'
import { isBlockedEitherDirection, getBlockedUserIds } from '../shared/blockUtils'

const prisma = new PrismaClient()

const router = Router()

// Register DM public key
router.post('/identity',
  requireAuth({ field: 'userId' }),
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
      return res.json(identity)
    } catch (error: any) {
      console.error('POST /api/dm/identity error:', error)
      return res.status(500).json({ error: error.message })
    }
  }
)

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
  requireAuth({ field: 'userId' }),
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
        include: { user: { select: { username: true, displayName: true, avatarUrl: true, image: true, tokenId: true } } }
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
  }}),
  async (req: Request, res: Response) => {
    try {
      const userId = Number(req.query.userId)
      if (isNaN(userId)) {
        return res.status(400).json({ error: 'userId query parameter is required' })
      }

      const limit = Math.min(Number(req.query.limit) || 50, 100)
      const offset = Number(req.query.offset) || 0

      const { conversations, hasMore } = await dmService.getConversations(userId, limit, offset)

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

// Send an encrypted message
router.post('/messages',
  requireAuth({ field: 'senderId' }),
  async (req: Request, res: Response) => {
    try {
      const { conversationId, senderId, encryptedPayload, contentType } = req.body
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
            shadowBlocked: true
          }
        })
        return res.json(message)
      }

      // Check DM privacy settings of the recipient
      if (peer) {
        const peerIdentity = await prisma.dmIdentity.findUnique({
          where: { userId: peer.userId },
          include: { user: { select: { username: true, displayName: true, avatarUrl: true, image: true, tokenId: true } } }
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

      const message = await dmService.sendMessage({
        conversationId,
        senderId: Number(senderId),
        encryptedPayload,
        contentType
      })

      // Broadcast via WebSocket
      dmWebSocketService.broadcastMessage(message)

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
  }}),
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
  requireAuth({ field: 'userId' }),
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
  }}),
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
  }}),
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
  }}),
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

// Get DM settings for a user
router.get('/settings',
  async (req: any, res: any) => {
    try {
      const userId = Number(req.query.userId)
      if (!userId) return res.status(400).json({ error: 'userId is required' })

      const identity = await prisma.dmIdentity.findUnique({
        where: { userId },
        select: { dmPrivacy: true }
      })

      res.json({ dmPrivacy: identity?.dmPrivacy || 'EVERYONE' })
    } catch (error: any) {
      console.error('GET /api/dm/settings error:', error)
      res.status(500).json({ error: error.message })
    }
  }
)

// Update DM settings
router.put('/settings',
  requireAuth({ field: 'userId' }),
  async (req: any, res: any) => {
    try {
      const { userId, dmPrivacy } = req.body
      if (!userId) return res.status(400).json({ error: 'userId is required' })

      const validValues = ['EVERYONE', 'FOLLOWERS', 'FOLLOWING']
      if (!validValues.includes(dmPrivacy)) {
        return res.status(400).json({ error: `dmPrivacy must be one of: ${validValues.join(', ')}` })
      }

      await prisma.dmIdentity.update({
        where: { userId: Number(userId) },
        data: { dmPrivacy }
      })

      res.json({ success: true, dmPrivacy })
    } catch (error: any) {
      console.error('PUT /api/dm/settings error:', error)
      res.status(500).json({ error: error.message })
    }
  }
)

export default router

import { Router, Request, Response } from 'express'
import { PrismaClient } from '@prisma/client'
import dmService from '../../services/DmService'
import dmWebSocketService from '../../services/DmService/websocket'
import { requireAuth } from '../middleware/auth'

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
      const peerHasIdentity = await dmService.hasIdentity(Number(peerUserId))
      if (!peerHasIdentity) {
        return res.status(400).json({ error: 'Peer has not enabled DMs' })
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

      const conversations = await dmService.getConversations(userId)
      return res.json({ conversations })
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

export default router

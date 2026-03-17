import { Router, Request, Response } from 'express'
import dmService from '../../services/DmService'
import dmWebSocketService from '../../services/DmService/websocket'
import { requireAuth } from '../middleware/auth'

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

      const messages = await dmService.getMessages(conversationId, userId, limit, before)
      return res.json({ messages })
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

export default router

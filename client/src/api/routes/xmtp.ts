import { Request, Response, Router } from 'express'
import XmtpIdentityService from '../../services/XmtpService'
import XmtpMessagingService from '../../services/XmtpService/messaging'
import { authenticateToken } from '../middleware/auth'

const router = Router()

/**
 * Register XMTP identity for a user
 * POST /api/xmtp/identity/register
 */
router.post('/identity/register', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { tokenId, walletAddress } = req.body

    if (!tokenId || !walletAddress) {
      return res.status(400).json({ error: 'Token ID and wallet address are required' })
    }

    const identity = await XmtpIdentityService.registerIdentity(tokenId, walletAddress)

    res.json({
      success: true,
      identity: {
        userId: identity.userId,
        walletAddress: identity.walletAddress,
        installationId: identity.installationId,
        registrationId: identity.registrationId
      }
    })
  } catch (error) {
    console.error('Error registering XMTP identity:', error)
    res.status(500).json({ error: 'Failed to register XMTP identity' })
  }
})

/**
 * Get XMTP identity for a user
 * GET /api/xmtp/identity/:userId
 */
router.get('/identity/:userId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId)

    const identity = await XmtpIdentityService.getIdentity(userId)

    if (!identity) {
      return res.status(404).json({ error: 'XMTP identity not found' })
    }

    res.json({
      success: true,
      identity: {
        userId: identity.userId,
        walletAddress: identity.walletAddress,
        installationId: identity.installationId,
        registrationId: identity.registrationId
      }
    })
  } catch (error) {
    console.error('Error getting XMTP identity:', error)
    res.status(500).json({ error: 'Failed to get XMTP identity' })
  }
})

/**
 * Check if a wallet can receive XMTP messages
 * GET /api/xmtp/can-message/:walletAddress
 */
router.get('/can-message/:walletAddress', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.params
    const { userId } = req.query

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' })
    }

    // Initialize client for the requesting user
    await XmtpIdentityService.initializeClient(parseInt(userId as string))
    const canMessage = await XmtpIdentityService.canMessage(walletAddress)

    res.json({
      success: true,
      canMessage
    })
  } catch (error) {
    console.error('Error checking messaging capability:', error)
    res.status(500).json({ error: 'Failed to check messaging capability' })
  }
})

/**
 * Create a new conversation
 * POST /api/xmtp/conversations
 */
router.post('/conversations', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { creatorId, participantIds, type, name, description } = req.body

    if (!creatorId || !participantIds || participantIds.length === 0) {
      return res.status(400).json({ error: 'Creator ID and participant IDs are required' })
    }

    const conversation = await XmtpMessagingService.createConversation({
      creatorId,
      participantIds,
      type,
      name,
      description
    })

    res.json({
      success: true,
      conversation
    })
  } catch (error) {
    console.error('Error creating conversation:', error)
    res.status(500).json({ error: 'Failed to create conversation' })
  }
})

/**
 * Get conversations for a user
 * GET /api/xmtp/conversations
 */
router.get('/conversations', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { userId } = req.query

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' })
    }

    const conversations = await XmtpMessagingService.getConversations(parseInt(userId as string))

    res.json({
      success: true,
      conversations
    })
  } catch (error) {
    console.error('Error getting conversations:', error)
    res.status(500).json({ error: 'Failed to get conversations' })
  }
})

/**
 * Send a message
 * POST /api/xmtp/messages
 */
router.post('/messages', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { conversationId, senderId, content, contentType, parentMessageId } = req.body

    if (!conversationId || !senderId || !content) {
      return res.status(400).json({ error: 'Conversation ID, sender ID, and content are required' })
    }

    const message = await XmtpMessagingService.sendMessage({
      conversationId,
      senderId,
      content,
      contentType,
      parentMessageId
    })

    res.json({
      success: true,
      message
    })
  } catch (error) {
    console.error('Error sending message:', error)
    res.status(500).json({ error: 'Failed to send message' })
  }
})

/**
 * Get messages for a conversation
 * GET /api/xmtp/conversations/:conversationId/messages
 */
router.get('/conversations/:conversationId/messages', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { conversationId } = req.params
    const { userId, limit, before } = req.query

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' })
    }

    const messages = await XmtpMessagingService.getMessages(
      conversationId,
      parseInt(userId as string),
      limit ? parseInt(limit as string) : 50,
      before as string
    )

    res.json({
      success: true,
      messages
    })
  } catch (error) {
    console.error('Error getting messages:', error)
    res.status(500).json({ error: 'Failed to get messages' })
  }
})

/**
 * Mark messages as delivered
 * POST /api/xmtp/messages/delivered
 */
router.post('/messages/delivered', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { messageIds, userId } = req.body

    if (!messageIds || !userId) {
      return res.status(400).json({ error: 'Message IDs and user ID are required' })
    }

    await XmtpMessagingService.markDelivered(messageIds, userId)

    res.json({
      success: true
    })
  } catch (error) {
    console.error('Error marking messages as delivered:', error)
    res.status(500).json({ error: 'Failed to mark messages as delivered' })
  }
})

/**
 * Mark messages as read
 * POST /api/xmtp/messages/read
 */
router.post('/messages/read', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { messageIds, userId } = req.body

    if (!messageIds || !userId) {
      return res.status(400).json({ error: 'Message IDs and user ID are required' })
    }

    await XmtpMessagingService.markRead(messageIds, userId)

    res.json({
      success: true
    })
  } catch (error) {
    console.error('Error marking messages as read:', error)
    res.status(500).json({ error: 'Failed to mark messages as read' })
  }
})

/**
 * Edit a message
 * PUT /api/xmtp/messages/:messageId
 */
router.put('/messages/:messageId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { messageId } = req.params
    const { userId, content } = req.body

    if (!userId || !content) {
      return res.status(400).json({ error: 'User ID and content are required' })
    }

    const message = await XmtpMessagingService.editMessage(messageId, userId, content)

    res.json({
      success: true,
      message
    })
  } catch (error) {
    console.error('Error editing message:', error)
    res.status(500).json({ error: 'Failed to edit message' })
  }
})

/**
 * Delete a message
 * DELETE /api/xmtp/messages/:messageId
 */
router.delete('/messages/:messageId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { messageId } = req.params
    const { userId } = req.query

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' })
    }

    await XmtpMessagingService.deleteMessage(messageId, parseInt(userId as string))

    res.json({
      success: true
    })
  } catch (error) {
    console.error('Error deleting message:', error)
    res.status(500).json({ error: 'Failed to delete message' })
  }
})

export default router
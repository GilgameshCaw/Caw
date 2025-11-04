import { Request, Response, Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { v4 as uuidv4 } from 'uuid'
import XmtpIdentityService from '../../services/XmtpService'
import XmtpMessagingService from '../../services/XmtpService/messaging'
import { authenticateToken } from '../middleware/auth'

const router = Router()

// Ensure upload directory exists
const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'messages')
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir)
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`
    cb(null, uniqueName)
  }
})

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 5 // Max 5 files at once
  },
  fileFilter: (req, file, cb) => {
    // Allow images and common document types
    const allowedTypes = /jpeg|jpg|png|gif|webp|pdf|doc|docx|txt|zip/
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase())
    const mimetype = allowedTypes.test(file.mimetype)

    if (mimetype && extname) {
      return cb(null, true)
    } else {
      cb(new Error('Invalid file type') as any)
    }
  }
})

/**
 * Register XMTP identity for a user
 * POST /api/xmtp/identity/register
 */
// TODO: Re-enable authentication after testing
router.post('/identity/register', async (req: Request, res: Response) => {
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
// TODO: Re-enable authentication after testing
router.get('/identity/:userId', async (req: Request, res: Response) => {
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
// TODO: Re-enable authentication after testing
router.post('/conversations', async (req: Request, res: Response) => {
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
// TODO: Re-enable authentication after testing
router.get('/conversations', async (req: Request, res: Response) => {
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
// TODO: Re-enable authentication after testing
router.post('/messages', async (req: Request, res: Response) => {
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
// TODO: Re-enable authentication after testing
router.get('/conversations/:conversationId/messages', async (req: Request, res: Response) => {
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

/**
 * Upload files for a message
 * POST /api/xmtp/messages/upload
 */
router.post('/messages/upload', authenticateToken, upload.array('files', 5), async (req: Request, res: Response) => {
  try {
    if (!req.files || !Array.isArray(req.files)) {
      return res.status(400).json({ error: 'No files uploaded' })
    }

    const uploadedFiles = req.files.map((file: Express.Multer.File) => ({
      filename: file.filename,
      originalName: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      url: `/uploads/messages/${file.filename}`
    }))

    res.json({
      success: true,
      files: uploadedFiles
    })
  } catch (error) {
    console.error('Error uploading files:', error)
    res.status(500).json({ error: 'Failed to upload files' })
  }
})

/**
 * Send a message with attachments
 * POST /api/xmtp/messages/with-attachments
 */
router.post('/messages/with-attachments', authenticateToken, upload.array('files', 5), async (req: Request, res: Response) => {
  try {
    const { conversationId, senderId, content, contentType, parentMessageId } = req.body

    if (!conversationId || !senderId) {
      return res.status(400).json({ error: 'Conversation ID and sender ID are required' })
    }

    // Process uploaded files if any
    let attachments = []
    if (req.files && Array.isArray(req.files)) {
      attachments = req.files.map((file: Express.Multer.File) => ({
        filename: file.filename,
        originalName: file.originalname,
        size: file.size,
        mimetype: file.mimetype,
        url: `/uploads/messages/${file.filename}`
      }))
    }

    // Create message content with attachments
    const messageContent = {
      text: content || '',
      attachments
    }

    const message = await XmtpMessagingService.sendMessage({
      conversationId,
      senderId,
      content: JSON.stringify(messageContent),
      contentType: attachments.length > 0 ? 'media' : (contentType || 'text'),
      parentMessageId
    })

    res.json({
      success: true,
      message
    })
  } catch (error) {
    console.error('Error sending message with attachments:', error)
    res.status(500).json({ error: 'Failed to send message with attachments' })
  }
})

/**
 * Search messages (returns encrypted messages for client-side decryption)
 * GET /api/xmtp/messages/search
 */
// TODO: Re-enable authentication after testing
router.get('/messages/search', async (req: Request, res: Response) => {
  try {
    const { userId, from, to } = req.query

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' })
    }

    // Get all conversations for the user
    const conversations = await XmtpMessagingService.getConversations(parseInt(userId as string))

    // Get messages within date range for all conversations
    const allMessages = []
    for (const conversation of conversations) {
      try {
        const messages = await XmtpMessagingService.getMessages(
          conversation.id,
          parseInt(userId as string),
          1000, // Get more messages for search
          to as string
        )

        // Filter by date range if provided
        const filteredMessages = messages.filter(msg => {
          const msgDate = new Date(msg.createdAt)
          const startDate = from ? new Date(from as string) : new Date(0)
          const endDate = to ? new Date(to as string) : new Date()
          return msgDate >= startDate && msgDate <= endDate
        })

        allMessages.push(...filteredMessages.map(msg => ({
          ...msg,
          conversationId: conversation.id
        })))
      } catch (error) {
        console.error(`Error getting messages for conversation ${conversation.id}:`, error)
      }
    }

    res.json({
      success: true,
      messages: allMessages
    })
  } catch (error) {
    console.error('Error searching messages:', error)
    res.status(500).json({ error: 'Failed to search messages' })
  }
})

export default router
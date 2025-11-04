import { Request, Response, Router } from 'express'
import SecureXmtpStorageService from '../../services/XmtpService/secure-storage'
import { authenticateToken } from '../middleware/auth'

const router = Router()

/**
 * Register XMTP identity
 * POST /api/xmtp/identity/register
 */
router.post('/identity/register', async (req: Request, res: Response) => {
  try {
    const { walletAddress, userId, tokenId } = req.body

    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address is required' })
    }

    // Store the XMTP identity initialization
    await SecureXmtpStorageService.storeIdentity({
      walletAddress,
      userId: userId || null,
      tokenId: tokenId || null,
      registeredAt: new Date()
    })

    res.json({
      success: true,
      message: 'XMTP identity registered successfully'
    })
  } catch (error) {
    console.error('Error registering XMTP identity:', error)
    res.status(500).json({ error: 'Failed to register XMTP identity' })
  }
})

/**
 * Store encrypted conversation metadata
 * POST /api/xmtp/conversations/sync
 */
router.post('/conversations/sync', async (req: Request, res: Response) => {
  try {
    const { conversations } = req.body

    if (!conversations || !Array.isArray(conversations)) {
      return res.status(400).json({ error: 'Conversations array is required' })
    }

    const stored = []
    for (const conv of conversations) {
      try {
        const result = await SecureXmtpStorageService.storeConversation({
          topic: conv.topic,
          peerAddress: conv.peerAddress,
          createdAt: new Date(conv.createdAt),
          metadata: conv.context
        })
        stored.push(result)
      } catch (error) {
        console.error(`Failed to store conversation ${conv.topic}:`, error)
      }
    }

    res.json({
      success: true,
      stored: stored.length
    })
  } catch (error) {
    console.error('Error syncing conversations:', error)
    res.status(500).json({ error: 'Failed to sync conversations' })
  }
})

/**
 * Store encrypted message
 * POST /api/xmtp/messages/store
 */
router.post('/messages/store', async (req: Request, res: Response) => {
  try {
    const { topic, messageId, senderAddress, encryptedPayload } = req.body

    if (!topic || !messageId || !senderAddress || !encryptedPayload) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const message = await SecureXmtpStorageService.storeMessage({
      topic,
      messageId,
      senderAddress,
      encryptedPayload,
      timestamp: new Date()
    })

    res.json({
      success: true,
      messageId: message.id
    })
  } catch (error) {
    console.error('Error storing message:', error)
    res.status(500).json({ error: 'Failed to store message' })
  }
})

/**
 * Get encrypted messages for sync
 * GET /api/xmtp/messages/encrypted
 */
router.get('/messages/encrypted', async (req: Request, res: Response) => {
  try {
    const { topic, limit } = req.query

    if (!topic) {
      return res.status(400).json({ error: 'Topic is required' })
    }

    const messages = await SecureXmtpStorageService.getEncryptedMessages(
      topic as string,
      limit ? parseInt(limit as string) : 100
    )

    res.json({
      success: true,
      messages
    })
  } catch (error) {
    console.error('Error getting encrypted messages:', error)
    res.status(500).json({ error: 'Failed to get messages' })
  }
})

/**
 * Get conversations by wallet address
 * GET /api/xmtp/conversations/by-wallet
 */
router.get('/conversations/by-wallet', async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.query

    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address is required' })
    }

    const conversations = await SecureXmtpStorageService.getConversations(
      walletAddress as string
    )

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
 * Link wallet to user account (optional)
 * POST /api/xmtp/link-wallet
 */
router.post('/link-wallet', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { walletAddress, userId } = req.body

    if (!walletAddress || !userId) {
      return res.status(400).json({ error: 'Wallet address and user ID are required' })
    }

    await SecureXmtpStorageService.linkWalletToUser(walletAddress, userId)

    res.json({
      success: true
    })
  } catch (error) {
    console.error('Error linking wallet:', error)
    res.status(500).json({ error: 'Failed to link wallet' })
  }
})

export default router
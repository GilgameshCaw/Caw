import { Router, Request, Response } from 'express'
import { PrismaClient } from '@prisma/client'

const router = Router()
const prisma = new PrismaClient()

/**
 * Get conversations for a specific user (token)
 * GET /api/conversations/:userId
 */
router.get('/:userId', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId)

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid userId' })
    }

    // Get all conversations where this user is a participant
    const participations = await prisma.conversationParticipant.findMany({
      where: {
        userId,
        leftAt: null // Only active conversations
      },
      include: {
        conversation: {
          include: {
            participants: {
              where: { leftAt: null },
              include: {
                identity: {
                  include: {
                    user: {
                      select: {
                        tokenId: true,
                        username: true,
                        displayName: true,
                        avatarUrl: true,
                        address: true
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      orderBy: {
        conversation: {
          lastMessageAt: 'desc'
        }
      }
    })

    const conversations = participations.map(p => ({
      id: p.conversation.id,
      type: p.conversation.type,
      topic: p.conversation.topic,
      name: p.conversation.name,
      description: p.conversation.description,
      avatarUrl: p.conversation.avatarUrl,
      lastMessageAt: p.conversation.lastMessageAt,
      lastMessageId: p.conversation.lastMessageId,
      unreadCount: p.unreadCount,
      participants: p.conversation.participants.map(part => ({
        userId: part.identity.user.tokenId,
        username: part.identity.user.username,
        displayName: part.identity.user.displayName,
        avatarUrl: part.identity.user.avatarUrl,
        walletAddress: part.identity.user.address,
        isAdmin: part.isAdmin,
        joinedAt: part.joinedAt
      }))
    }))

    res.json({ conversations })
  } catch (error: any) {
    console.error('[Conversations] Error fetching conversations:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Create or get a DM conversation between two users
 * POST /api/conversations/dm
 */
router.post('/dm', async (req: Request, res: Response) => {
  try {
    const { userId, peerUserId, topic } = req.body

    if (!userId || !peerUserId || !topic) {
      return res.status(400).json({ error: 'userId, peerUserId, and topic are required' })
    }

    // Check if conversation already exists between these specific users
    // Note: Multiple conversations can share the same XMTP topic if users share wallets
    const existingConversation = await prisma.conversation.findFirst({
      where: {
        type: 'DM',
        AND: [
          {
            participants: {
              some: { userId }
            }
          },
          {
            participants: {
              some: { userId: peerUserId }
            }
          }
        ]
      },
      include: {
        participants: {
          include: {
            identity: {
              include: {
                user: {
                  select: {
                    tokenId: true,
                    username: true,
                    displayName: true,
                    avatarUrl: true,
                    address: true
                  }
                }
              }
            }
          }
        }
      }
    })

    if (existingConversation) {
      // Return existing conversation
      console.log('[Conversations] Found existing conversation:', existingConversation.id, 'topic:', existingConversation.topic)
      return res.json({
        conversation: {
          id: existingConversation.id,
          type: existingConversation.type,
          topic: existingConversation.topic,
          participants: existingConversation.participants.map(p => ({
            userId: p.identity.user.tokenId,
            username: p.identity.user.username,
            displayName: p.identity.user.displayName,
            avatarUrl: p.identity.user.avatarUrl,
            walletAddress: p.identity.user.address
          }))
        }
      })
    }

    // Ensure both users have XMTP identities before creating conversation
    const userIdentity = await prisma.xmtpIdentity.findUnique({
      where: { userId }
    })
    const peerIdentity = await prisma.xmtpIdentity.findUnique({
      where: { userId: peerUserId }
    })

    if (!userIdentity || !peerIdentity) {
      return res.status(400).json({
        error: 'Both users must have XMTP identities to create a conversation',
        details: {
          userHasIdentity: !!userIdentity,
          peerHasIdentity: !!peerIdentity
        }
      })
    }

    // Create new conversation
    const conversation = await prisma.conversation.create({
      data: {
        type: 'DM',
        topic,
        creatorId: userId,
        participants: {
          create: [
            { userId },
            { userId: peerUserId }
          ]
        }
      },
      include: {
        participants: {
          include: {
            identity: {
              include: {
                user: {
                  select: {
                    tokenId: true,
                    username: true,
                    displayName: true,
                    avatarUrl: true,
                    address: true
                  }
                }
              }
            }
          }
        }
      }
    })

    res.json({
      conversation: {
        id: conversation.id,
        type: conversation.type,
        topic: conversation.topic,
        participants: conversation.participants.map(p => ({
          userId: p.identity.user.tokenId,
          username: p.identity.user.username,
          displayName: p.identity.user.displayName,
          avatarUrl: p.identity.user.avatarUrl,
          walletAddress: p.identity.user.address
        }))
      }
    })
  } catch (error: any) {
    console.error('[Conversations] Error creating DM:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Get messages for a conversation
 * GET /api/conversations/:conversationId/messages
 */
router.get('/:conversationId/messages', async (req: Request, res: Response) => {
  try {
    const { conversationId } = req.params
    const userId = req.query.userId ? parseInt(req.query.userId as string) : null

    if (!userId) {
      return res.status(400).json({ error: 'userId query parameter required' })
    }

    // Verify user is a participant
    const participation = await prisma.conversationParticipant.findFirst({
      where: {
        conversationId,
        userId,
        leftAt: null
      }
    })

    if (!participation) {
      return res.status(403).json({ error: 'User is not a participant in this conversation' })
    }

    // Get messages
    const messages = await prisma.message.findMany({
      where: {
        conversationId
      },
      include: {
        sender: {
          include: {
            user: {
              select: {
                tokenId: true,
                username: true,
                displayName: true,
                avatarUrl: true
              }
            }
          }
        }
      },
      orderBy: {
        createdAt: 'asc'
      }
    })

    res.json({ messages })
  } catch (error: any) {
    console.error('[Conversations] Error fetching messages:', error)
    res.status(500).json({ error: error.message })
  }
})

export default router

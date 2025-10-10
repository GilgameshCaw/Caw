import { Client, Conversation as XmtpConversation } from '@xmtp/node-sdk'
import { PrismaClient, ConversationType, MessageStatus } from '@prisma/client'
import XmtpIdentityService from './index'

const prisma = new PrismaClient()

export interface SendMessageParams {
  conversationId: string
  senderId: number
  content: string
  contentType?: string
  parentMessageId?: string
}

export interface CreateConversationParams {
  creatorId: number
  participantIds: number[]
  type?: ConversationType
  name?: string
  description?: string
}

export class XmtpMessagingService {
  private clients: Map<number, Client> = new Map()

  /**
   * Get or create XMTP client for a user
   */
  private async getClient(userId: number): Promise<Client> {
    if (this.clients.has(userId)) {
      return this.clients.get(userId)!
    }

    const client = await XmtpIdentityService.initializeClient(userId)
    this.clients.set(userId, client)
    return client
  }

  /**
   * Create a new conversation (DM or Group)
   */
  async createConversation(params: CreateConversationParams) {
    const { creatorId, participantIds, type = 'DM', name, description } = params

    // Get creator's XMTP client
    const client = await this.getClient(creatorId)

    // For DMs, ensure only 2 participants
    if (type === 'DM' && participantIds.length !== 1) {
      throw new Error('DM conversations must have exactly 2 participants')
    }

    // Get wallet addresses for participants
    const participantWallets = await Promise.all(
      participantIds.map(async (userId) => {
        const identity = await XmtpIdentityService.getIdentity(userId)
        if (!identity) throw new Error(`XMTP identity not found for user ${userId}`)
        return identity.walletAddress
      })
    )

    // Create XMTP conversation
    let xmtpConversation: XmtpConversation

    if (type === 'DM') {
      // Create 1-to-1 conversation
      xmtpConversation = await client.conversations.newConversation(participantWallets[0])
    } else {
      // Create group conversation (when supported by XMTP SDK)
      // For now, we'll simulate group with metadata
      xmtpConversation = await client.conversations.newConversation(participantWallets[0])
    }

    // Save conversation to database
    const conversation = await prisma.conversation.create({
      data: {
        type,
        topic: xmtpConversation.topic,
        name,
        description,
        creatorId,
        metadata: type === 'GROUP' ? { participantWallets } : undefined,
        participants: {
          create: [
            {
              userId: creatorId,
              isAdmin: true
            },
            ...participantIds.map(userId => ({
              userId,
              isAdmin: false
            }))
          ]
        }
      },
      include: {
        participants: {
          include: {
            identity: {
              include: {
                user: true
              }
            }
          }
        }
      }
    })

    return conversation
  }

  /**
   * Send a message in a conversation
   */
  async sendMessage(params: SendMessageParams) {
    const { conversationId, senderId, content, contentType = 'text', parentMessageId } = params

    // Get conversation
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId }
    })

    if (!conversation) {
      throw new Error('Conversation not found')
    }

    // Check if sender is a participant
    const participant = await prisma.conversationParticipant.findUnique({
      where: {
        conversationId_userId: {
          conversationId,
          userId: senderId
        }
      }
    })

    if (!participant) {
      throw new Error('Sender is not a participant in this conversation')
    }

    // Get sender's XMTP client
    const client = await this.getClient(senderId)

    // Get XMTP conversation
    const xmtpConversations = await client.conversations.list()
    const xmtpConversation = xmtpConversations.find(c => c.topic === conversation.topic)

    if (!xmtpConversation) {
      throw new Error('XMTP conversation not found')
    }

    // Send message via XMTP
    await xmtpConversation.send(content)

    // Save message to database
    const message = await prisma.message.create({
      data: {
        conversationId,
        senderId,
        content,
        contentType,
        parentMessageId,
        status: 'SENT'
      }
    })

    // Update conversation's last message
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: new Date(),
        lastMessageId: message.id
      }
    })

    // Update unread counts for other participants
    await prisma.conversationParticipant.updateMany({
      where: {
        conversationId,
        userId: { not: senderId }
      },
      data: {
        unreadCount: { increment: 1 }
      }
    })

    return message
  }

  /**
   * Get messages for a conversation
   */
  async getMessages(conversationId: string, userId: number, limit = 50, before?: string) {
    // Check if user is a participant
    const participant = await prisma.conversationParticipant.findUnique({
      where: {
        conversationId_userId: {
          conversationId,
          userId
        }
      }
    })

    if (!participant) {
      throw new Error('User is not a participant in this conversation')
    }

    // Get messages
    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        deletedAt: null,
        ...(before && { createdAt: { lt: new Date(before) } })
      },
      include: {
        sender: {
          include: {
            user: true
          }
        },
        replies: {
          include: {
            sender: {
              include: {
                user: true
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: limit
    })

    // Mark messages as read
    const messageIds = messages.map(m => m.id)
    await prisma.messageReceipt.createMany({
      data: messageIds.map(messageId => ({
        messageId,
        userId,
        readAt: new Date()
      })),
      skipDuplicates: true
    })

    // Update participant's last read time and reset unread count
    await prisma.conversationParticipant.update({
      where: {
        conversationId_userId: {
          conversationId,
          userId
        }
      },
      data: {
        lastReadAt: new Date(),
        unreadCount: 0
      }
    })

    return messages.reverse()
  }

  /**
   * Get conversations for a user
   */
  async getConversations(userId: number) {
    const conversations = await prisma.conversation.findMany({
      where: {
        participants: {
          some: {
            userId,
            leftAt: null
          }
        }
      },
      include: {
        participants: {
          include: {
            identity: {
              include: {
                user: true
              }
            }
          }
        }
      },
      orderBy: {
        lastMessageAt: 'desc'
      }
    })

    // Get unread counts
    const conversationsWithUnread = await Promise.all(
      conversations.map(async (conv) => {
        const participant = await prisma.conversationParticipant.findUnique({
          where: {
            conversationId_userId: {
              conversationId: conv.id,
              userId
            }
          }
        })

        return {
          ...conv,
          unreadCount: participant?.unreadCount || 0
        }
      })
    )

    return conversationsWithUnread
  }

  /**
   * Mark messages as delivered
   */
  async markDelivered(messageIds: string[], userId: number) {
    await prisma.messageReceipt.createMany({
      data: messageIds.map(messageId => ({
        messageId,
        userId,
        deliveredAt: new Date()
      })),
      skipDuplicates: true
    })
  }

  /**
   * Mark messages as read
   */
  async markRead(messageIds: string[], userId: number) {
    await prisma.messageReceipt.updateMany({
      where: {
        messageId: { in: messageIds },
        userId
      },
      data: {
        readAt: new Date()
      }
    })
  }

  /**
   * Edit a message
   */
  async editMessage(messageId: string, userId: number, newContent: string) {
    const message = await prisma.message.findUnique({
      where: { id: messageId }
    })

    if (!message) {
      throw new Error('Message not found')
    }

    if (message.senderId !== userId) {
      throw new Error('You can only edit your own messages')
    }

    const updatedMessage = await prisma.message.update({
      where: { id: messageId },
      data: {
        content: newContent,
        editedAt: new Date()
      }
    })

    return updatedMessage
  }

  /**
   * Delete a message
   */
  async deleteMessage(messageId: string, userId: number) {
    const message = await prisma.message.findUnique({
      where: { id: messageId }
    })

    if (!message) {
      throw new Error('Message not found')
    }

    if (message.senderId !== userId) {
      throw new Error('You can only delete your own messages')
    }

    const deletedMessage = await prisma.message.update({
      where: { id: messageId },
      data: {
        deletedAt: new Date()
      }
    })

    return deletedMessage
  }
}

export default new XmtpMessagingService()
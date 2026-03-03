/**
 * Secure XMTP Storage Service
 *
 * This service ONLY stores encrypted messages and conversation metadata.
 * All encryption/decryption happens client-side with user wallets.
 * The server never has access to private keys or decrypted content.
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

export interface SecureConversationData {
  topic: string
  peerAddress: string
  createdAt: Date
  metadata?: any
}

export interface SecureMessageData {
  topic: string
  messageId: string
  senderAddress: string
  encryptedPayload: string
  timestamp: Date
}

export class SecureXmtpStorageService {
  /**
   * Store encrypted conversation metadata
   * Called from client after establishing XMTP conversation
   */
  async storeConversation(data: SecureConversationData) {
    // Store minimal conversation metadata
    // No private keys, no user content
    return await prisma.conversation.upsert({
      where: { topic: data.topic },
      update: {
        updatedAt: new Date()
      },
      create: {
        id: data.topic,
        topic: data.topic,
        type: 'DM',
        creatorId: 0, // Will be updated when user links their account
        metadata: {
          peerAddress: data.peerAddress,
          createdAt: data.createdAt,
          ...data.metadata
        }
      }
    })
  }

  /**
   * Store encrypted message
   * Called from client after sending via XMTP
   */
  async storeMessage(data: SecureMessageData) {
    // Store only encrypted payload
    // Server cannot decrypt this without user's wallet
    return await prisma.message.create({
      data: {
        id: data.messageId,
        conversationId: data.topic,
        senderId: 0, // Will be linked via wallet address
        senderWallet: data.senderAddress,
        encryptedPayload: data.encryptedPayload,
        messageTopic: data.topic,
        contentType: 'encrypted',
        metadata: {
          timestamp: data.timestamp
        }
      }
    })
  }

  /**
   * Retrieve encrypted messages for syncing
   * Returns encrypted payloads for client-side decryption
   */
  async getEncryptedMessages(topic: string, limit = 100) {
    return await prisma.message.findMany({
      where: {
        messageTopic: topic,
        deletedAt: null
      },
      select: {
        id: true,
        encryptedPayload: true,
        senderWallet: true,
        createdAt: true,
        metadata: true
      },
      orderBy: { createdAt: 'desc' },
      take: limit
    })
  }

  /**
   * Get conversation metadata for syncing
   */
  async getConversations(walletAddress: string) {
    // Return conversations where user is a participant
    // Based on wallet address, not user ID
    return await prisma.$queryRaw`
      SELECT DISTINCT c.*
      FROM "Conversation" c
      WHERE c.metadata->>'peerAddress' = ${walletAddress}
        OR c."topic" IN (
          SELECT DISTINCT "messageTopic"
          FROM "Message"
          WHERE "senderWallet" = ${walletAddress}
        )
      ORDER BY c."updatedAt" DESC
    `
  }

  /**
   * Store XMTP identity registration
   * Called when user initializes XMTP
   */
  async storeIdentity(data: {
    walletAddress: string
    userId: number | null
    tokenId: number | null
    registeredAt: Date
  }) {
    // Store the XMTP identity in the User table
    // This tracks which users have initialized XMTP
    const user = await prisma.user.upsert({
      where: {
        tokenId: data.tokenId || 0
      },
      update: {},
      create: {
        id: data.tokenId || 0,
        tokenId: data.tokenId || 0,
        username: `user_${data.tokenId || Date.now()}`
      }
    })

    return user
  }

  /**
   * Link wallet address to user account
   * Optional - for user profile features
   */
  async linkWalletToUser(walletAddress: string, userId: number) {
    // Update existing conversations and messages with user ID
    await prisma.$transaction([
      prisma.conversation.updateMany({
        where: {
          metadata: {
            path: ['peerAddress'],
            equals: walletAddress
          }
        },
        data: {
          creatorId: userId
        }
      }),
      prisma.message.updateMany({
        where: {
          senderWallet: walletAddress
        },
        data: {
          senderId: userId
        }
      })
    ])
  }

  /**
   * Delete expired encrypted messages
   * For privacy and storage management
   */
  async cleanupOldMessages(daysToKeep = 30) {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep)

    return await prisma.message.deleteMany({
      where: {
        createdAt: {
          lt: cutoffDate
        }
      }
    })
  }
}

export default new SecureXmtpStorageService()
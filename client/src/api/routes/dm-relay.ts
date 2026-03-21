// src/api/routes/dm-relay.ts
//
// Cross-instance DM relay endpoint. Other instances POST encrypted DM
// payloads here so messages reach users regardless of which instance
// they're connected to.

import { Router } from 'express'
import { verifyMessage } from 'ethers'
import dmWebSocketService from '../../services/DmService/websocket'
import { prisma } from '../../prismaClient'

const router = Router()

/**
 * POST /api/dm/relay
 *
 * Accept a relayed DM from another instance.
 * The message is already E2E encrypted — we just store it and notify via WebSocket.
 */
router.post('/', async (req, res) => {
  try {
    const {
      encryptedPayload,
      senderId,
      recipientId,
      conversationId,
      contentType = 'text',
      timestamp,
      signature,
      senderAddress,
    } = req.body

    // Basic validation
    if (!encryptedPayload || !senderId || !recipientId || !conversationId || !timestamp || !signature || !senderAddress) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    // Verify the message isn't too old (5 minute window to prevent replay)
    const age = Date.now() - timestamp
    if (age > 5 * 60 * 1000 || age < -60 * 1000) {
      return res.status(400).json({ error: 'Message timestamp out of range' })
    }

    // Verify signature to prevent spam injection
    const message = `dm-relay:${senderId}:${recipientId}:${timestamp}`
    try {
      const recovered = verifyMessage(message, signature)
      if (recovered.toLowerCase() !== senderAddress.toLowerCase()) {
        return res.status(403).json({ error: 'Invalid signature' })
      }
    } catch {
      return res.status(403).json({ error: 'Signature verification failed' })
    }

    // Validate deterministic conversation ID format
    const minId = Math.min(Number(senderId), Number(recipientId))
    const maxId = Math.max(Number(senderId), Number(recipientId))
    const expectedConvId = `dm:${minId}:${maxId}`

    if (conversationId !== expectedConvId) {
      return res.status(400).json({ error: 'Invalid conversation ID format' })
    }

    // Get or create conversation
    let conversation = await prisma.conversation.findUnique({
      where: { id: conversationId }
    })

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          id: conversationId,
          type: 'DM',
          creatorId: Number(senderId),
          participants: {
            create: [
              { userId: Number(senderId) },
              { userId: Number(recipientId) },
            ]
          }
        }
      })
    }

    // Ensure sender is a participant
    await prisma.conversationParticipant.upsert({
      where: { conversationId_userId: { conversationId, userId: Number(senderId) } },
      create: { conversationId, userId: Number(senderId) },
      update: {},
    })

    // Store the message
    const messageRecord = await prisma.message.create({
      data: {
        conversationId,
        senderId: Number(senderId),
        encryptedPayload,
        contentType,
      },
      include: {
        sender: {
          include: {
            user: { select: { username: true, displayName: true, avatarUrl: true, tokenId: true } }
          }
        }
      }
    })

    // Update conversation metadata
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: messageRecord.createdAt, lastMessageId: messageRecord.id }
    })

    // Increment unread count for the recipient
    await prisma.conversationParticipant.updateMany({
      where: { conversationId, userId: Number(recipientId) },
      data: { unreadCount: { increment: 1 } }
    })

    // Broadcast via WebSocket to connected users
    dmWebSocketService.broadcastMessage(messageRecord)

    return res.json({ status: 'relayed', messageId: messageRecord.id })
  } catch (error: any) {
    console.error('[DM Relay] Error:', error.message)
    return res.status(500).json({ error: 'Relay failed' })
  }
})

export default router

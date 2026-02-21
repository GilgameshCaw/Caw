import { Server as HttpServer } from 'http'
import { Server as SocketIOServer, Socket } from 'socket.io'
import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'

const prisma = new PrismaClient()
const JWT_SECRET = process.env.JWT_SECRET || 'caw-secret-key-dev'

interface AuthenticatedSocket extends Socket {
  userId?: number
  username?: string
}

export class XmtpWebSocketService {
  private io: SocketIOServer | null = null
  private userSockets: Map<number, Set<string>> = new Map()

  /**
   * Initialize WebSocket server
   */
  initialize(server: HttpServer) {
    console.log('[XMTP-WS] Initializing WebSocket server on path: /xmtp-ws')

    this.io = new SocketIOServer(server, {
      cors: {
        origin: process.env.NODE_ENV === 'development' ? '*' : process.env.ALLOWED_ORIGINS?.split(',') || [],
        methods: ['GET', 'POST'],
        credentials: true
      },
      path: '/xmtp-ws/'
    })

    console.log('[XMTP-WS] WebSocket server created')

    // Authentication middleware
    this.io.use(async (socket: AuthenticatedSocket, next) => {
      console.log('[XMTP-WS] New connection attempt from:', socket.handshake.address)
      console.log('[XMTP-WS] Auth data:', socket.handshake.auth)

      try {
        const token = socket.handshake.auth.token
        if (!token) {
          console.error('[XMTP-WS] No token provided')
          return next(new Error('Authentication required'))
        }

        let decoded: any

        // Try JWT verification first
        try {
          decoded = jwt.verify(token, JWT_SECRET) as any
          console.log('[XMTP-WS] JWT token verified successfully')
        } catch (jwtErr) {
          console.log('[XMTP-WS] JWT verification failed, trying base64 decode')
          // If JWT verification fails, try base64 decode for development
          try {
            const decodedBase64 = Buffer.from(token, 'base64').toString('utf-8')
            decoded = JSON.parse(decodedBase64)
            console.log('[XMTP-WS] Using base64-encoded auth token (development mode)', decoded)
          } catch (base64Err) {
            console.error('[XMTP-WS] Base64 decode failed:', base64Err)
            throw new Error('Invalid token format')
          }
        }

        socket.userId = decoded.userId
        socket.username = decoded.username

        if (!socket.userId || !socket.username) {
          console.error('[XMTP-WS] Invalid token payload - missing userId or username')
          return next(new Error('Invalid token payload'))
        }

        console.log('[XMTP-WS] Authentication successful for user:', socket.username, 'ID:', socket.userId)

        // Track user's socket connections
        if (!this.userSockets.has(socket.userId)) {
          this.userSockets.set(socket.userId, new Set())
        }
        this.userSockets.get(socket.userId)!.add(socket.id)

        next()
      } catch (err: any) {
        console.error('[XMTP-WS] Authentication error:', err.message)
        console.error('[XMTP-WS] Error stack:', err.stack)
        next(new Error('Invalid token'))
      }
    })

    // Handle connections
    this.io.on('connection', (socket: AuthenticatedSocket) => {
      console.log(`[XMTP-WS] User ${socket.username} (${socket.userId}) connected`)

      // Join user's personal room for direct messages
      socket.join(`user:${socket.userId}`)

      // Join conversation rooms
      this.joinUserConversations(socket)

      // Handle joining a conversation
      socket.on('join-conversation', async (conversationId: string) => {
        // Verify user is a participant
        const participant = await prisma.conversationParticipant.findUnique({
          where: {
            conversationId_userId: {
              conversationId,
              userId: socket.userId!
            }
          }
        })

        if (participant) {
          socket.join(`conversation:${conversationId}`)
          console.log(`[XMTP-WS] User ${socket.userId} joined conversation ${conversationId}`)
        }
      })

      // Handle leaving a conversation
      socket.on('leave-conversation', (conversationId: string) => {
        socket.leave(`conversation:${conversationId}`)
        console.log(`[XMTP-WS] User ${socket.userId} left conversation ${conversationId}`)
      })

      // Handle typing indicators
      socket.on('typing', async (data: { conversationId: string; isTyping: boolean }) => {
        socket.to(`conversation:${data.conversationId}`).emit('user-typing', {
          userId: socket.userId,
          username: socket.username,
          isTyping: data.isTyping
        })
      })

      // Handle message read receipts
      socket.on('mark-read', async (data: { messageIds: string[] }) => {
        await prisma.messageReceipt.createMany({
          data: data.messageIds.map(messageId => ({
            messageId,
            userId: socket.userId!,
            readAt: new Date()
          })),
          skipDuplicates: true
        })

        // Notify sender that message was read
        const messages = await prisma.message.findMany({
          where: { id: { in: data.messageIds } },
          select: { senderId: true, conversationId: true }
        })

        for (const message of messages) {
          this.emitToUser(message.senderId, 'message-read', {
            messageIds: data.messageIds,
            readBy: socket.userId,
            conversationId: message.conversationId
          })
        }
      })

      // Handle disconnection
      socket.on('disconnect', () => {
        console.log(`[XMTP-WS] User ${socket.username} (${socket.userId}) disconnected`)

        // Remove socket from user's socket set
        if (socket.userId && this.userSockets.has(socket.userId)) {
          this.userSockets.get(socket.userId)!.delete(socket.id)
          if (this.userSockets.get(socket.userId)!.size === 0) {
            this.userSockets.delete(socket.userId)
          }
        }
      })
    })
  }

  /**
   * Join user's conversations on connect
   */
  private async joinUserConversations(socket: AuthenticatedSocket) {
    if (!socket.userId) return

    const conversations = await prisma.conversationParticipant.findMany({
      where: {
        userId: socket.userId,
        leftAt: null
      },
      select: {
        conversationId: true
      }
    })

    for (const { conversationId } of conversations) {
      socket.join(`conversation:${conversationId}`)
    }

    console.log(`[XMTP-WS] User ${socket.userId} joined ${conversations.length} conversations`)
  }

  /**
   * Emit event to a specific user
   */
  emitToUser(userId: number, event: string, data: any) {
    if (!this.io) return

    const socketIds = this.userSockets.get(userId)
    if (socketIds) {
      for (const socketId of socketIds) {
        this.io.to(socketId).emit(event, data)
      }
    }
  }

  /**
   * Emit event to a conversation
   */
  emitToConversation(conversationId: string, event: string, data: any, excludeUserId?: number) {
    if (!this.io) return

    const room = `conversation:${conversationId}`

    if (excludeUserId) {
      // Emit to all in room except the excluded user
      const excludedSockets = this.userSockets.get(excludeUserId)
      if (excludedSockets) {
        for (const socketId of excludedSockets) {
          this.io.to(room).except(socketId).emit(event, data)
        }
      } else {
        this.io.to(room).emit(event, data)
      }
    } else {
      this.io.to(room).emit(event, data)
    }
  }

  /**
   * Broadcast new message to conversation participants
   */
  broadcastMessage(message: any) {
    this.emitToConversation(
      message.conversationId,
      'new-message',
      message,
      message.senderId // Exclude sender from broadcast
    )
  }

  /**
   * Broadcast conversation update
   */
  broadcastConversationUpdate(conversationId: string, update: any) {
    this.emitToConversation(conversationId, 'conversation-update', update)
  }

  /**
   * Notify user of new conversation
   */
  notifyNewConversation(userId: number, conversation: any) {
    this.emitToUser(userId, 'new-conversation', conversation)
  }
}

export default new XmtpWebSocketService()
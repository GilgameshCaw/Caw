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

export class DmWebSocketService {
  private io: SocketIOServer | null = null
  private userSockets: Map<number, Set<string>> = new Map()

  initialize(server: HttpServer) {
    console.log('[DM-WS] Initializing WebSocket server on path: /dm-ws')

    this.io = new SocketIOServer(server, {
      cors: {
        origin: process.env.NODE_ENV === 'development' ? '*' : process.env.ALLOWED_ORIGINS?.split(',') || [],
        methods: ['GET', 'POST'],
        credentials: true
      },
      path: '/dm-ws/'
    })

    // Authentication middleware
    this.io.use(async (socket: AuthenticatedSocket, next) => {
      try {
        const token = socket.handshake.auth.token
        if (!token) return next(new Error('Authentication required'))

        let decoded: any

        try {
          decoded = jwt.verify(token, JWT_SECRET) as any
        } catch {
          // Fallback: base64 decode for development
          try {
            decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'))
          } catch {
            throw new Error('Invalid token format')
          }
        }

        socket.userId = decoded.userId
        socket.username = decoded.username

        if (!socket.userId || !socket.username) {
          return next(new Error('Invalid token payload'))
        }

        if (!this.userSockets.has(socket.userId)) {
          this.userSockets.set(socket.userId, new Set())
        }
        this.userSockets.get(socket.userId)!.add(socket.id)

        next()
      } catch (err: any) {
        next(new Error('Invalid token'))
      }
    })

    this.io.on('connection', (socket: AuthenticatedSocket) => {
      console.log(`[DM-WS] User ${socket.username} (${socket.userId}) connected`)

      socket.join(`user:${socket.userId}`)
      this.joinUserConversations(socket)

      socket.on('join-conversation', async (conversationId: string) => {
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
        }
      })

      socket.on('leave-conversation', (conversationId: string) => {
        socket.leave(`conversation:${conversationId}`)
      })

      socket.on('typing', (data: { conversationId: string; isTyping: boolean }) => {
        socket.to(`conversation:${data.conversationId}`).emit('user-typing', {
          userId: socket.userId,
          username: socket.username,
          isTyping: data.isTyping
        })
      })

      socket.on('mark-read', async (data: { messageIds: string[] }) => {
        await prisma.messageReceipt.createMany({
          data: data.messageIds.map(messageId => ({
            messageId,
            userId: socket.userId!,
            readAt: new Date()
          })),
          skipDuplicates: true
        })

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

      socket.on('disconnect', () => {
        if (socket.userId && this.userSockets.has(socket.userId)) {
          this.userSockets.get(socket.userId)!.delete(socket.id)
          if (this.userSockets.get(socket.userId)!.size === 0) {
            this.userSockets.delete(socket.userId)
          }
        }
      })
    })
  }

  private async joinUserConversations(socket: AuthenticatedSocket) {
    if (!socket.userId) return

    const conversations = await prisma.conversationParticipant.findMany({
      where: { userId: socket.userId },
      select: { conversationId: true }
    })

    for (const { conversationId } of conversations) {
      socket.join(`conversation:${conversationId}`)
    }
  }

  emitToUser(userId: number, event: string, data: any) {
    if (!this.io) return

    const socketIds = this.userSockets.get(userId)
    if (socketIds) {
      for (const socketId of socketIds) {
        this.io.to(socketId).emit(event, data)
      }
    }
  }

  emitToConversation(conversationId: string, event: string, data: any, excludeUserId?: number) {
    if (!this.io) return

    const room = `conversation:${conversationId}`

    if (excludeUserId) {
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

  broadcastMessage(message: any) {
    this.emitToConversation(
      message.conversationId,
      'new-message',
      message,
      message.senderId
    )
  }

  broadcastConversationUpdate(conversationId: string, update: any) {
    this.emitToConversation(conversationId, 'conversation-update', update)
  }

  notifyNewConversation(userId: number, conversation: any) {
    this.emitToUser(userId, 'new-conversation', conversation)
  }

  notifyMessageEdited(conversationId: string, messageId: string, senderId: number) {
    this.emitToConversation(conversationId, 'message-edited', { messageId, senderId }, senderId)
  }

  notifyMessageDeleted(conversationId: string, messageId: string, senderId: number) {
    this.emitToConversation(conversationId, 'message-deleted', { messageId, senderId }, senderId)
  }
}

export default new DmWebSocketService()

import { Server as HttpServer } from 'http'
import { Server as SocketIOServer, Socket } from 'socket.io'
import { prisma } from '../../prismaClient'
import { getSession } from '../../api/sessionStore'
import { SESSION_COOKIE_NAME } from '../../api/middleware/auth'

interface AuthenticatedSocket extends Socket {
  userId?: number
  username?: string
}

// ---------------------------------------------------------------------------
// Per-socket token-bucket rate limiter (M-2)
// ---------------------------------------------------------------------------
interface Bucket { tokens: number; lastRefill: number }
interface SocketBuckets { typing: Bucket; markRead: Bucket }

const eventBuckets = new Map<string, SocketBuckets>()

function makeBucket(maxTokens: number): Bucket {
  return { tokens: maxTokens, lastRefill: Date.now() }
}

function consumeToken(
  socketId: string,
  event: 'typing' | 'markRead',
  maxTokens: number,
  refillPerSec: number
): boolean {
  if (!eventBuckets.has(socketId)) {
    eventBuckets.set(socketId, {
      typing: makeBucket(5),
      markRead: makeBucket(10)
    })
  }

  const buckets = eventBuckets.get(socketId)!
  const bucket = buckets[event]
  const now = Date.now()
  const elapsed = (now - bucket.lastRefill) / 1000
  const refilled = Math.floor(elapsed * refillPerSec)

  if (refilled > 0) {
    bucket.tokens = Math.min(maxTokens, bucket.tokens + refilled)
    bucket.lastRefill = now
  }

  if (bucket.tokens <= 0) return false
  bucket.tokens -= 1
  return true
}

// ---------------------------------------------------------------------------

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
      path: '/dm-ws/',
      // M-1: polling removed — WS-only; polling SIDs appear in nginx logs
      // and are replayable. Modern browsers (2020+) universally support WS.
      transports: ['websocket']
    })

    // Authentication middleware — uses the same session token system as the REST API.
    // Token source order: HttpOnly cookie (preferred, set by /api/auth/verify) →
    // handshake.auth.sessionToken (legacy in-band path for clients that still
    // hold the token in JS). Once all clients are using cookie auth, the
    // handshake.auth path can be removed and /api/auth/verify can stop
    // returning sessionToken in its JSON body. Audit fix 2026-05-14 (F1
    // follow-up).
    this.io.use(async (socket: AuthenticatedSocket, next) => {
      try {
        const cookieHeader = socket.handshake.headers.cookie || ''
        const cookieRe = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]+)`)
        const cookieToken = cookieHeader.match(cookieRe)?.[1]
        const sessionToken = cookieToken
          ? decodeURIComponent(cookieToken)
          : (socket.handshake.auth.sessionToken as string | undefined)
        const userId = Number(socket.handshake.auth.userId)
        // Intentionally ignore client-supplied username — it is resolved from
        // the DB below after session validation to prevent impersonation.
        // (L-2: client-supplied username in handshake.)

        if (!sessionToken || !userId) {
          return next(new Error('Authentication required'))
        }

        // Verify session token in Redis (same as REST API auth)
        const session = await getSession(sessionToken)
        if (!session) {
          return next(new Error('Invalid or expired session'))
        }

        // Verify the userId is authorized in this session
        if (!session.authorizedTokenIds.includes(userId)) {
          return next(new Error('Token not authorized in session'))
        }

        // Resolve username from DB — never trust the client-supplied value.
        const dbUser = await prisma.user.findUnique({
          where: { tokenId: userId },
          select: { username: true },
        })

        socket.userId = userId
        socket.username = dbUser?.username ?? undefined

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
        // M-2: 5-token bucket, refill 1/sec
        if (!consumeToken(socket.id, 'typing', 5, 1)) return
        socket.to(`conversation:${data.conversationId}`).emit('user-typing', {
          userId: socket.userId,
          username: socket.username,
          isTyping: data.isTyping
        })
      })

      socket.on('mark-read', async (data: { messageIds: string[] }) => {
        // L-2: hard cap on array length
        if (!Array.isArray(data.messageIds) || data.messageIds.length > 100) return

        // M-2: 10-token bucket, refill 1/sec
        if (!consumeToken(socket.id, 'markRead', 10, 1)) return

        // H-2: verify each messageId belongs to a conversation where
        // socket.userId is a participant; silently drop non-member ids.
        const rawMessages = await prisma.message.findMany({
          where: { id: { in: data.messageIds } },
          select: { id: true, conversationId: true, senderId: true }
        })

        if (rawMessages.length === 0) return

        const convIds = [...new Set(rawMessages.map(m => m.conversationId))]
        const memberships = await prisma.conversationParticipant.findMany({
          where: { conversationId: { in: convIds }, userId: socket.userId! },
          select: { conversationId: true }
        })
        const memberConvIds = new Set(memberships.map(p => p.conversationId))

        const allowedMessages = rawMessages.filter(m => memberConvIds.has(m.conversationId))
        if (allowedMessages.length === 0) return

        const allowedIds = allowedMessages.map(m => m.id)

        await prisma.messageReceipt.createMany({
          data: allowedIds.map(messageId => ({
            messageId,
            userId: socket.userId!,
            readAt: new Date()
          })),
          skipDuplicates: true
        })

        for (const message of allowedMessages) {
          this.emitToUser(message.senderId, 'message-read', {
            messageIds: allowedIds,
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
        // M-2: clean up rate-limit buckets
        eventBuckets.delete(socket.id)
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
    // Splice in conversationId so receivers can route by conversation
    // without joining every event to its room context.
    this.emitToConversation(conversationId, 'conversation-update', { conversationId, ...update })
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

  /**
   * Reaction added/removed. Broadcast to everyone *including* the actor —
   * unlike message edits where the actor already sees their own edit, the
   * reaction strip on their UI updates from the same event so we keep the
   * code path simple.
   */
  notifyReactionToggled(conversationId: string, payload: {
    messageId: string
    userId: number
    emoji: string
    added: boolean
  }) {
    this.emitToConversation(conversationId, payload.added ? 'reaction-added' : 'reaction-removed', payload)
  }

  /**
   * Force-disconnect all active WebSocket connections for a given userId.
   * Emits 'session-revoked' with { reason } before disconnecting so the
   * client can show a meaningful message. Safe to call when the user is
   * not connected — no-op in that case.
   *
   * Called by NftTransferWatcher after pruneTokenIdFromAllSessions() so
   * the previous NFT owner's open browser tab stops receiving live DM
   * events immediately on transfer.
   */
  disconnectUser(userId: number, reason: string): void {
    if (!this.io) return
    const socketIds = this.userSockets.get(userId)
    if (!socketIds || socketIds.size === 0) return

    for (const socketId of Array.from(socketIds)) {
      const socket = this.io.sockets.sockets.get(socketId)
      if (socket) {
        socket.emit('session-revoked', { reason })
        socket.disconnect(true)
      }
    }
    this.userSockets.delete(userId)
  }
}

export default new DmWebSocketService()

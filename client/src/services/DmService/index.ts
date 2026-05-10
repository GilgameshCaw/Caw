import { prisma } from '../../prismaClient'
import { deterministicConversationId } from '../DmRelayService'

export class DmService {
  /**
   * Register or update a user's DM public key
   */
  async registerIdentity(userId: number, walletAddress: string, publicKey: string, walletProof?: string | null) {
    return prisma.dmIdentity.upsert({
      where: { userId },
      create: { userId, walletAddress, publicKey, walletProof: walletProof ?? null },
      update: { walletAddress, publicKey, walletProof: walletProof ?? null }
    })
  }

  /**
   * Get a user's DM public key
   */
  async getPublicKey(userId: number): Promise<string | null> {
    const identity = await prisma.dmIdentity.findUnique({
      where: { userId },
      select: { publicKey: true }
    })
    return identity?.publicKey ?? null
  }

  /**
   * Batched form of getPublicKey. Returns a Map keyed by userId so callers
   * can answer "which users in this list have DM identities" with one
   * round-trip instead of N. Missing keys are simply absent from the map.
   */
  async getPublicKeysBatch(userIds: number[]): Promise<Map<number, string>> {
    if (userIds.length === 0) return new Map()
    const rows = await prisma.dmIdentity.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, publicKey: true },
    })
    const out = new Map<number, string>()
    for (const r of rows) out.set(r.userId, r.publicKey)
    return out
  }

  /**
   * Check if a user has a DM identity
   */
  async hasIdentity(userId: number): Promise<boolean> {
    const count = await prisma.dmIdentity.count({ where: { userId } })
    return count > 0
  }

  /**
   * Get or create a DM conversation between two users.
   * Returns existing conversation if one already exists.
   */
  async getOrCreateConversation(userIdA: number, userIdB: number) {
    // Look for existing conversation with both participants
    const existing = await prisma.conversation.findFirst({
      where: {
        type: 'DM',
        AND: [
          { participants: { some: { userId: userIdA } } },
          { participants: { some: { userId: userIdB } } }
        ]
      },
      include: {
        participants: {
          include: {
            identity: {
              include: {
                user: {
                  select: { username: true, displayName: true, avatarUrl: true, defaultAvatarId: true, image: true, address: true, tokenId: true }
                }
              }
            }
          }
        }
      }
    })

    if (existing) return existing

    // DM conversations use a deterministic id derived from the
    // (min, max) participant pair, so cross-instance relay can target
    // the same conversation regardless of which side wrote first.
    // Group conversations (future) keep the schema's UUID default.
    // The receive-side relay handler enforces this exact format
    // (dm-relay.ts), so any drift here breaks federation.
    const id = deterministicConversationId(userIdA, userIdB)

    return prisma.conversation.create({
      data: {
        id,
        type: 'DM',
        creatorId: userIdA,
        participants: {
          create: [
            { userId: userIdA },
            { userId: userIdB }
          ]
        }
      },
      include: {
        participants: {
          include: {
            identity: {
              include: {
                user: {
                  select: { username: true, displayName: true, avatarUrl: true, defaultAvatarId: true, image: true, address: true, tokenId: true }
                }
              }
            }
          }
        }
      }
    })
  }

  /**
   * Store an encrypted message
   */
  async sendMessage(params: {
    conversationId: string
    senderId: number
    encryptedPayload: string
    contentType?: string
    replyToMessageId?: string
    /**
     * Cross-instance relay dedup key. Set by the API route so the local
     * row and any relay echoes share an id; the partial unique index on
     * Message.relayId catches a peer fanning the message back to us.
     */
    relayId?: string
    /**
     * Inner sender sig over the canonical envelope (encryptedPayload,
     * senderId, recipientId, conversationId, contentType, timestamp)
     * by the user's DmIdentity secp256k1 private key. Audit fix
     * 2026-05-09 (Round 7 #1b). Verifier in /api/dm/messages already
     * resolved this against DmIdentity.publicKey for senderId; the
     * verdict rides through here as `verifiedSender`.
     */
    senderSig?: string | null
    verifiedSender?: boolean | null
  }) {
    const { conversationId, senderId, encryptedPayload, contentType = 'text', replyToMessageId, relayId, senderSig, verifiedSender } = params

    // Verify sender is a participant
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId: senderId } }
    })
    if (!participant) throw new Error('Not a participant in this conversation')

    // Validate the reply target exists in the same conversation. We don't
    // trust the client to scope this — without the conversation check, a
    // sender could thread a message onto a parent from another room.
    if (replyToMessageId) {
      const parent = await prisma.message.findUnique({
        where: { id: replyToMessageId },
        select: { conversationId: true }
      })
      if (!parent || parent.conversationId !== conversationId) {
        throw new Error('Reply target not found in this conversation')
      }
    }

    const message = await prisma.message.create({
      data: {
        conversationId,
        senderId,
        encryptedPayload,
        contentType,
        replyToMessageId: replyToMessageId || null,
        relayId: relayId || null,
        senderSig: senderSig ?? null,
        verifiedSender: verifiedSender ?? null,
      },
      include: {
        sender: {
          include: {
            user: { select: { username: true, displayName: true, avatarUrl: true, defaultAvatarId: true, image: true, tokenId: true } }
          }
        }
      }
    })

    // Update conversation's lastMessageAt and lastMessageId
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: message.createdAt, lastMessageId: message.id }
    })

    // Increment unread count for other participants
    await prisma.conversationParticipant.updateMany({
      where: {
        conversationId,
        userId: { not: senderId }
      },
      data: { unreadCount: { increment: 1 } }
    })

    return message
  }

  /**
   * Get messages for a conversation (encrypted — client decrypts).
   * Group rows: Message.encryptedPayload is null on disk; we splice in
   * the caller's per-recipient ciphertext so the FE shape stays stable.
   */
  async getMessages(conversationId: string, userId: number, limit = 50, before?: string) {
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } }
    })
    if (!participant) throw new Error('Not a participant in this conversation')

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { type: true },
    })
    const isGroup = conversation?.type === 'GROUP'

    const where: any = {
      conversationId,
      deletions: { none: { userId } },
      OR: [
        { shadowBlocked: false },
        { shadowBlocked: true, senderId: userId }
      ]
    }
    if (before) {
      const beforeMsg = await prisma.message.findUnique({ where: { id: before }, select: { createdAt: true } })
      if (beforeMsg) {
        where.createdAt = { lt: beforeMsg.createdAt }
      }
    }

    const messages = await prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        sender: {
          include: {
            user: { select: { username: true, displayName: true, avatarUrl: true, defaultAvatarId: true, image: true, tokenId: true } }
          }
        },
        reactions: {
          select: { id: true, userId: true, emoji: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
        ...(isGroup ? {
          recipientPayloads: {
            where: { recipientUserId: userId },
            select: { encryptedPayload: true },
          },
        } : {}),
      }
    })
    messages.reverse()

    let shaped: any[] = messages
    if (isGroup) {
      shaped = messages.map((m: any) => {
        const payload = m.recipientPayloads?.[0]?.encryptedPayload ?? null
        const { recipientPayloads, ...rest } = m
        return { ...rest, encryptedPayload: payload }
      })
    }

    // peerLastReadAt is meaningful only for DMs. Groups would need a
    // per-pair shape; the FE skips the seen indicator there.
    let peerLastReadAt: string | null = null
    if (!isGroup) {
      const otherParticipant = await prisma.conversationParticipant.findFirst({
        where: { conversationId, userId: { not: userId } }
      })
      peerLastReadAt = otherParticipant?.lastReadAt?.toISOString() || null
    }

    return { messages: shaped, peerLastReadAt }
  }

  /**
   * Get conversations for a user with unread counts.
   *
   * `inbox` filters by THIS user's participant.status:
   *   - 'main'     → ACCEPTED (the standard inbox)
   *   - 'requests' → REQUEST  (first-contact DMs awaiting accept)
   *   - 'all'      → no filter; used for badges + sync paths that need
   *                   the full set
   */
  async getConversations(
    userId: number,
    limit = 50,
    offset = 0,
    inbox: 'main' | 'requests' | 'all' = 'main',
  ) {
    // Filter out conversations that haven't seen any messages yet — when
    // someone "starts" a conversation by tapping a username, we create the
    // row eagerly so the encrypted handshake can land, but the inbox
    // shouldn't show a row with no last-message preview. The participant
    // record is preserved so that if/when the first message lands, this
    // query starts returning it.
    //
    // Each peer's DM publicKey rides along on the participant's identity
    // — the frontend uses it to compute the shared secret for the
    // last-message preview without a follow-up /api/dm/identity request.
    const statusFilter =
      inbox === 'main'     ? { status: 'ACCEPTED' as const } :
      inbox === 'requests' ? { status: 'REQUEST'  as const } :
      {}

    const participations = await prisma.conversationParticipant.findMany({
      where: {
        userId,
        // Hide rows where the caller has left/been removed — they no
        // longer see the conversation in their inbox.
        leftAt: null,
        ...statusFilter,
        conversation: {
          messages: { some: {} },
        },
      },
      take: limit + 1,
      skip: offset,
      include: {
        conversation: {
          include: {
            participants: {
              include: {
                identity: {
                  select: {
                    publicKey: true,
                    user: {
                      select: { username: true, displayName: true, avatarUrl: true, defaultAvatarId: true, image: true, address: true, tokenId: true }
                    }
                  }
                }
              }
            },
            messages: {
              where: {
                OR: [
                  { shadowBlocked: false },
                  { shadowBlocked: true, senderId: userId }
                ]
              },
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: {
                id: true,
                encryptedPayload: true,
                senderId: true,
                contentType: true,
                recipientPayloads: {
                  where: { recipientUserId: userId },
                  select: { encryptedPayload: true },
                },
              }
            }
          }
        }
      },
      orderBy: { conversation: { lastMessageAt: 'desc' } }
    })

    const hasMore = participations.length > limit
    if (hasMore) participations.pop()

    // Per-conversation unverified-unread count. Messages where
    // verifiedSender is explicitly `false` (sig present but didn't
    // recover to senderId's wallet) are counted SEPARATELY so the FE
    // badge can exclude them — they're forgeries from a malicious
    // relay node and shouldn't drive the user's "you have new messages"
    // signal. Messages with verifiedSender = NULL (legacy + migration
    // window, or no DmIdentity for the sender on this node) count as
    // normal unread. Audit fix 2026-05-09 (Round 7 #1a).
    const convIds = participations.map((p: any) => p.conversationId)
    const unverifiedCounts: Map<string, number> = new Map()
    if (convIds.length > 0) {
      const rows = await prisma.message.groupBy({
        by: ['conversationId'],
        where: {
          conversationId: { in: convIds },
          verifiedSender: false,
          shadowBlocked: false,
          createdAt: {
            // Anything since the user's lastReadAt for that conversation
            // — but lastReadAt is per-participant, so we approximate by
            // counting messages newer than `now - 30d`. The badge total
            // is rounded; users still see exact counts in-thread.
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          },
        },
        _count: { id: true },
      })
      for (const r of rows) {
        unverifiedCounts.set(r.conversationId, r._count.id)
      }
    }

    const conversations = participations.map((p: any) => {
      const last = p.conversation.messages[0] || null
      let shapedLast = last
      if (last && p.conversation.type === 'GROUP') {
        const payload = last.recipientPayloads?.[0]?.encryptedPayload ?? null
        const { recipientPayloads, ...rest } = last
        shapedLast = { ...rest, encryptedPayload: payload }
      }
      const unverifiedUnreadCount = unverifiedCounts.get(p.conversationId) || 0
      // The badge shows ONLY verified-or-unknown unread. unverifiedUnread
      // surfaces in the conversation thread under a "X unverifiable
      // messages" disclosure with explainer.
      const verifiedUnread = Math.max(0, p.unreadCount - unverifiedUnreadCount)
      return {
        ...p.conversation,
        lastMessage: shapedLast,
        unreadCount: verifiedUnread,
        unverifiedUnreadCount,
        myStatus: p.status,
        myRole: p.role,
      }
    })

    return { conversations, hasMore }
  }

  /**
   * Get the count of REQUEST conversations for the inbox tab badge.
   * Cheap — covers the (userId, status) index added in the same
   * migration as the column.
   */
  async getRequestCount(userId: number): Promise<number> {
    return prisma.conversationParticipant.count({
      where: {
        userId,
        status: 'REQUEST',
        conversation: { messages: { some: {} } },
      },
    })
  }

  /**
   * Flip a REQUEST conversation to ACCEPTED. No-op if already accepted.
   * Called explicitly via the accept CTA, AND implicitly on first
   * outbound reply (the act of replying = consent).
   */
  async acceptConversation(conversationId: string, userId: number): Promise<void> {
    await prisma.conversationParticipant.updateMany({
      where: { conversationId, userId, status: 'REQUEST' },
      data: { status: 'ACCEPTED' },
    })
  }

  /**
   * Mark messages as read and reset unread count
   */
  async markRead(messageIds: string[], userId: number) {
    if (messageIds.length === 0) return

    // Get conversation IDs from the messages
    const messages = await prisma.message.findMany({
      where: { id: { in: messageIds } },
      select: { conversationId: true }
    })
    const conversationIds = [...new Set(messages.map(m => m.conversationId))]

    // Create read receipts
    await prisma.messageReceipt.createMany({
      data: messageIds.map(messageId => ({
        messageId,
        userId,
        readAt: new Date()
      })),
      skipDuplicates: true
    })

    // Reset unread count for the user in those conversations
    for (const conversationId of conversationIds) {
      await prisma.conversationParticipant.updateMany({
        where: { conversationId, userId },
        data: { unreadCount: 0, lastReadAt: new Date() }
      })
    }

    return { conversationIds }
  }

  /**
   * Toggle a reaction on a DM. If the (messageId, userId, emoji) row
   * already exists, delete it; otherwise insert it. Returns the new state
   * (`added` true on insert, false on delete) plus the conversationId so
   * callers can broadcast over the websocket.
   *
   * Caller must verify the user is a participant in the message's
   * conversation — the route layer does this.
   */
  async toggleReaction(messageId: string, userId: number, emoji: string) {
    // findUnique won't work for the compound unique key without the keys
    // in the right shape, so we do a simple findFirst.
    const existing = await prisma.messageReaction.findFirst({
      where: { messageId, userId, emoji },
      select: { id: true },
    })

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { conversationId: true },
    })
    if (!message) throw new Error('Message not found')

    if (existing) {
      await prisma.messageReaction.delete({ where: { id: existing.id } })
      return { added: false, conversationId: message.conversationId }
    }
    await prisma.messageReaction.create({
      data: { messageId, userId, emoji },
    })
    return { added: true, conversationId: message.conversationId }
  }

  /**
   * Read the user's customized 5-emoji default reaction strip. Returns
   * an empty array when the user hasn't customized — UI applies its own
   * defaults in that case so the server can ship an updated default set
   * without a migration.
   */
  async getDefaultReactions(userId: number): Promise<string[]> {
    const identity = await prisma.dmIdentity.findUnique({
      where: { userId },
      select: { defaultDmReactions: true },
    })
    return identity?.defaultDmReactions ?? []
  }

  /**
   * Set the user's customized default reaction strip. Caller is expected
   * to have already validated the array length / emoji content; we store
   * whatever they send (clamped to a sane upper bound).
   */
  async setDefaultReactions(userId: number, emojis: string[]) {
    // Cap at 10 even though the UI uses 5 — gives the UI a small grace
    // band for future expansion without another migration. The DB stores
    // whatever's passed; downstream readers should slice to the count
    // they want to display.
    const clamped = emojis.slice(0, 10)
    await prisma.dmIdentity.update({
      where: { userId },
      data: { defaultDmReactions: clamped },
    })
    return clamped
  }
}

export default new DmService()

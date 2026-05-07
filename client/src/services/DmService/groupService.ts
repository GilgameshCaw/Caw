import { prisma } from '../../prismaClient'
import crypto from 'crypto'
import type { Prisma, Conversation, ConversationParticipantRole } from '@prisma/client'

const GROUP_MIN_MEMBERS = 3
const GROUP_MAX_MEMBERS = 10
const INVITE_TOKEN_BYTES = 24

export class GroupServiceError extends Error {
  status: number
  code: string
  payload?: any
  constructor(status: number, code: string, message: string, payload?: any) {
    super(message)
    this.status = status
    this.code = code
    this.payload = payload
  }
}

const memberInclude = {
  participants: {
    include: {
      identity: {
        select: {
          publicKey: true,
          allowGroupInvites: true,
          user: {
            select: { username: true, displayName: true, avatarUrl: true, defaultAvatarId: true, image: true, address: true, tokenId: true },
          },
        },
      },
    },
  },
} as const

async function assertNoBlocksAcrossSet(memberIds: number[]) {
  if (memberIds.length < 2) return
  const blocks = await prisma.block.findMany({
    where: {
      OR: [
        { blockerId: { in: memberIds }, blockedId: { in: memberIds } },
      ],
    },
    select: { blockerId: true, blockedId: true },
  })
  if (blocks.length > 0) {
    const b = blocks[0]
    throw new GroupServiceError(400, 'BLOCK_CONFLICT', 'A block exists between two of the listed members.', {
      blockerId: b.blockerId,
      blockedId: b.blockedId,
    })
  }
}

async function assertIdentitiesExist(userIds: number[]) {
  if (userIds.length === 0) return
  const rows = await prisma.dmIdentity.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true },
  })
  const have = new Set(rows.map(r => r.userId))
  const missing = userIds.filter(id => !have.has(id))
  if (missing.length > 0) {
    throw new GroupServiceError(400, 'NO_DM_IDENTITY', 'One or more members have not enabled DMs.', { missing })
  }
}

async function getActiveParticipant(tx: Prisma.TransactionClient, conversationId: string, userId: number) {
  const p = await tx.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { id: true, role: true, leftAt: true, conversationId: true, userId: true },
  })
  if (!p || p.leftAt) return null
  return p
}

async function requireOwner(tx: Prisma.TransactionClient, conversationId: string, userId: number) {
  const conv = await tx.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, type: true },
  })
  if (!conv) throw new GroupServiceError(404, 'NOT_FOUND', 'Conversation not found')
  if (conv.type !== 'GROUP') throw new GroupServiceError(400, 'NOT_GROUP', 'Conversation is not a group')

  const p = await getActiveParticipant(tx, conversationId, userId)
  if (!p) throw new GroupServiceError(403, 'NOT_PARTICIPANT', 'You are not an active member of this group')
  if (p.role !== 'OWNER') throw new GroupServiceError(403, 'NOT_OWNER', 'Only the group owner can perform this action')
  return p
}

async function requireParticipant(tx: Prisma.TransactionClient, conversationId: string, userId: number) {
  const conv = await tx.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, type: true },
  })
  if (!conv) throw new GroupServiceError(404, 'NOT_FOUND', 'Conversation not found')
  if (conv.type !== 'GROUP') throw new GroupServiceError(400, 'NOT_GROUP', 'Conversation is not a group')
  const p = await getActiveParticipant(tx, conversationId, userId)
  if (!p) throw new GroupServiceError(403, 'NOT_PARTICIPANT', 'You are not an active member of this group')
  return p
}

async function activeMemberCount(tx: Prisma.TransactionClient, conversationId: string): Promise<number> {
  return tx.conversationParticipant.count({
    where: { conversationId, leftAt: null },
  })
}

async function writeSystemMessage(
  tx: Prisma.TransactionClient,
  conversationId: string,
  actorUserId: number,
  contentType: string,
  payload: any,
) {
  // System messages: encryptedPayload null, contentType marks the kind,
  // systemPayload carries metadata. lastMessageAt updates so the inbox
  // reorders, but we deliberately skip the unread-count increment on
  // group system events (see addMembers / removeMember / etc.).
  const message = await tx.message.create({
    data: {
      conversationId,
      senderId: actorUserId,
      encryptedPayload: null,
      contentType,
      systemPayload: payload,
    },
  })
  await tx.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: message.createdAt, lastMessageId: message.id },
  })
  return message
}

export class GroupService {
  /**
   * Create a new group. Caller becomes OWNER. Other members are added
   * as MEMBER. Enforces 3..10 size cap, identity existence, no pairwise
   * Blocks across the resulting member set, and per-target opt-out.
   */
  async createGroup(params: {
    creatorUserId: number
    memberUserIds: number[]
    name?: string
    avatarUrl?: string
  }) {
    const { creatorUserId, name, avatarUrl } = params
    const others = [...new Set(params.memberUserIds.map(Number))].filter(
      n => Number.isInteger(n) && n > 0 && n !== creatorUserId,
    )
    const total = 1 + others.length
    if (total < GROUP_MIN_MEMBERS) {
      throw new GroupServiceError(400, 'TOO_FEW_MEMBERS', `Groups need at least ${GROUP_MIN_MEMBERS} members.`)
    }
    if (total > GROUP_MAX_MEMBERS) {
      throw new GroupServiceError(400, 'TOO_MANY_MEMBERS', `Groups can hold at most ${GROUP_MAX_MEMBERS} members.`)
    }

    // Creator must already have a DM identity (we use senderId on system
    // rows). Other members must too — there's no encryption key for
    // anyone without one.
    await assertIdentitiesExist([creatorUserId, ...others])

    // Opt-out gate (direct add). Invite-redeem path takes a different
    // route and overrides opt-out (explicit consent).
    const optOut = await prisma.dmIdentity.findMany({
      where: { userId: { in: others }, allowGroupInvites: false },
      select: { userId: true, user: { select: { username: true } } },
    })
    if (optOut.length > 0) {
      throw new GroupServiceError(400, 'OPT_OUT', 'Some members have opted out of group invites.', {
        users: optOut.map(o => ({ userId: o.userId, username: o.user.username })),
      })
    }

    // Block check across the entire set, including creator. We refuse
    // even if A blocks B and neither is the creator — the group can't
    // function with an internal block edge.
    await assertNoBlocksAcrossSet([creatorUserId, ...others])

    return prisma.$transaction(async tx => {
      const conv = await tx.conversation.create({
        data: {
          type: 'GROUP',
          creatorId: creatorUserId,
          name: name ?? null,
          avatarUrl: avatarUrl ?? null,
          participants: {
            create: [
              { userId: creatorUserId, role: 'OWNER' as ConversationParticipantRole },
              ...others.map(uid => ({ userId: uid, role: 'MEMBER' as ConversationParticipantRole })),
            ],
          },
        },
        include: memberInclude,
      })

      await writeSystemMessage(tx, conv.id, creatorUserId, 'system:created', {
        memberUserIds: [creatorUserId, ...others],
        name: name ?? null,
      })

      return tx.conversation.findUnique({ where: { id: conv.id }, include: memberInclude })
    })
  }

  /**
   * Owner adds members. Respects opt-out. Member-cap enforced inside
   * the transaction so concurrent adds can't exceed 10.
   */
  async addMembers(params: { conversationId: string; actorUserId: number; targetUserIds: number[] }) {
    const { conversationId, actorUserId } = params
    const targets = [...new Set(params.targetUserIds.map(Number))].filter(n => Number.isInteger(n) && n > 0)
    if (targets.length === 0) {
      throw new GroupServiceError(400, 'NO_TARGETS', 'No valid target user ids.')
    }

    await assertIdentitiesExist(targets)

    const optOut = await prisma.dmIdentity.findMany({
      where: { userId: { in: targets }, allowGroupInvites: false },
      select: { userId: true, user: { select: { username: true } } },
    })
    if (optOut.length > 0) {
      throw new GroupServiceError(400, 'OPT_OUT', 'Some users have opted out of group invites.', {
        users: optOut.map(o => ({ userId: o.userId, username: o.user.username })),
      })
    }

    return prisma.$transaction(async tx => {
      await requireOwner(tx, conversationId, actorUserId)

      // Existing participants table — distinguish "active", "previously
      // left/removed" (leftAt set, can rejoin), and "never seen".
      const existing = await tx.conversationParticipant.findMany({
        where: { conversationId, userId: { in: targets } },
        select: { userId: true, leftAt: true, id: true },
      })
      const existingByUser = new Map(existing.map(e => [e.userId, e]))

      const activeIds: number[] = []
      const allMembers = await tx.conversationParticipant.findMany({
        where: { conversationId, leftAt: null },
        select: { userId: true },
      })
      const activeSet = new Set(allMembers.map(m => m.userId))
      for (const id of targets) if (activeSet.has(id)) activeIds.push(id)
      if (activeIds.length > 0) {
        throw new GroupServiceError(400, 'ALREADY_MEMBER', 'One or more users are already active members.', { userIds: activeIds })
      }

      const willBeMembers = [...allMembers.map(m => m.userId), ...targets]
      if (willBeMembers.length > GROUP_MAX_MEMBERS) {
        throw new GroupServiceError(400, 'GROUP_FULL', `Groups can hold at most ${GROUP_MAX_MEMBERS} members.`)
      }

      await assertNoBlocksAcrossSet(willBeMembers)

      // Reactivate previously-left rows in place; insert fresh rows for new ids.
      const now = new Date()
      for (const id of targets) {
        const prev = existingByUser.get(id)
        if (prev) {
          await tx.conversationParticipant.update({
            where: { id: prev.id },
            data: { leftAt: null, joinedAt: now, role: 'MEMBER', status: 'ACCEPTED', unreadCount: 0 },
          })
        } else {
          await tx.conversationParticipant.create({
            data: { conversationId, userId: id, role: 'MEMBER', status: 'ACCEPTED' },
          })
        }
      }

      await writeSystemMessage(tx, conversationId, actorUserId, 'system:added', {
        targetUserIds: targets,
      })

      return tx.conversation.findUnique({ where: { id: conversationId }, include: memberInclude })
    })
  }

  /**
   * Owner removes a member. Can't target self — owner uses leaveGroup
   * for that.
   */
  async removeMember(params: { conversationId: string; actorUserId: number; targetUserId: number }) {
    const { conversationId, actorUserId, targetUserId } = params
    if (actorUserId === targetUserId) {
      throw new GroupServiceError(400, 'CANNOT_REMOVE_SELF', 'Use leaveGroup to remove yourself.')
    }

    return prisma.$transaction(async tx => {
      await requireOwner(tx, conversationId, actorUserId)
      const target = await getActiveParticipant(tx, conversationId, targetUserId)
      if (!target) throw new GroupServiceError(404, 'NOT_MEMBER', 'Target is not an active member.')

      await tx.conversationParticipant.update({
        where: { id: target.id },
        data: { leftAt: new Date() },
      })

      await writeSystemMessage(tx, conversationId, actorUserId, 'system:removed', {
        targetUserId,
      })

      return tx.conversation.findUnique({ where: { id: conversationId }, include: memberInclude })
    })
  }

  /**
   * Caller leaves the group. If the caller was the owner and other
   * members remain, ownership transfers to the oldest-by-joinedAt
   * active remaining member.
   */
  async leaveGroup(params: { conversationId: string; actorUserId: number }) {
    const { conversationId, actorUserId } = params
    return prisma.$transaction(async tx => {
      const me = await requireParticipant(tx, conversationId, actorUserId)
      const wasOwner = me.role === 'OWNER'

      await tx.conversationParticipant.update({
        where: { id: me.id },
        data: { leftAt: new Date() },
      })

      let newOwnerUserId: number | null = null
      if (wasOwner) {
        const successor = await tx.conversationParticipant.findFirst({
          where: { conversationId, leftAt: null, userId: { not: actorUserId } },
          orderBy: { joinedAt: 'asc' },
        })
        if (successor) {
          await tx.conversationParticipant.update({
            where: { id: successor.id },
            data: { role: 'OWNER' },
          })
          newOwnerUserId = successor.userId
          await writeSystemMessage(tx, conversationId, actorUserId, 'system:ownerTransferred', {
            fromUserId: actorUserId,
            toUserId: newOwnerUserId,
          })
        }
      }

      await writeSystemMessage(tx, conversationId, actorUserId, 'system:left', {
        userId: actorUserId,
      })

      const remaining = await activeMemberCount(tx, conversationId)
      return {
        conversationId,
        leftUserId: actorUserId,
        newOwnerUserId,
        remainingMembers: remaining,
      }
    })
  }

  /**
   * Owner-only metadata edit (name + avatarUrl). System message records
   * the change.
   */
  async updateGroup(params: {
    conversationId: string
    actorUserId: number
    name?: string | null
    avatarUrl?: string | null
  }) {
    const { conversationId, actorUserId, name, avatarUrl } = params
    return prisma.$transaction(async tx => {
      await requireOwner(tx, conversationId, actorUserId)
      const before = await tx.conversation.findUnique({
        where: { id: conversationId },
        select: { name: true, avatarUrl: true },
      })
      if (!before) throw new GroupServiceError(404, 'NOT_FOUND', 'Conversation not found')

      const data: { name?: string | null; avatarUrl?: string | null } = {}
      if (name !== undefined) data.name = name
      if (avatarUrl !== undefined) data.avatarUrl = avatarUrl
      if (Object.keys(data).length === 0) {
        throw new GroupServiceError(400, 'NO_CHANGES', 'No fields supplied to update.')
      }

      const updated = await tx.conversation.update({
        where: { id: conversationId },
        data,
        include: memberInclude,
      })

      if (data.name !== undefined && data.name !== before.name) {
        await writeSystemMessage(tx, conversationId, actorUserId, 'system:renamed', {
          oldName: before.name,
          newName: data.name,
        })
      }
      if (data.avatarUrl !== undefined && data.avatarUrl !== before.avatarUrl) {
        await writeSystemMessage(tx, conversationId, actorUserId, 'system:avatarChanged', {
          oldAvatarUrl: before.avatarUrl,
          newAvatarUrl: data.avatarUrl,
        })
      }

      return updated
    })
  }

  /**
   * Get group metadata + active members. Caller must be a participant.
   */
  async getGroup(params: { conversationId: string; actorUserId: number }): Promise<Conversation> {
    const { conversationId, actorUserId } = params
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: memberInclude,
    })
    if (!conv) throw new GroupServiceError(404, 'NOT_FOUND', 'Conversation not found')
    if (conv.type !== 'GROUP') throw new GroupServiceError(400, 'NOT_GROUP', 'Conversation is not a group')
    const me = (conv as any).participants.find((p: any) => p.userId === actorUserId && !p.leftAt)
    if (!me) throw new GroupServiceError(403, 'NOT_PARTICIPANT', 'You are not an active member of this group')
    return conv
  }

  // ---------- invites ----------

  async mintInvite(params: {
    conversationId: string
    actorUserId: number
    expiresAt: Date
    maxUses: number
  }) {
    const { conversationId, actorUserId, expiresAt, maxUses } = params
    if (!(expiresAt instanceof Date) || isNaN(expiresAt.getTime())) {
      throw new GroupServiceError(400, 'BAD_EXPIRES', 'Invalid expiresAt')
    }
    if (expiresAt.getTime() <= Date.now()) {
      throw new GroupServiceError(400, 'BAD_EXPIRES', 'expiresAt must be in the future')
    }
    if (!Number.isInteger(maxUses) || maxUses <= 0 || maxUses > 100) {
      throw new GroupServiceError(400, 'BAD_MAX_USES', 'maxUses must be 1..100')
    }

    return prisma.$transaction(async tx => {
      await requireOwner(tx, conversationId, actorUserId)
      const token = crypto.randomBytes(INVITE_TOKEN_BYTES).toString('base64url')
      const invite = await tx.groupInvite.create({
        data: {
          conversationId,
          createdByUserId: actorUserId,
          expiresAt,
          maxUses,
          token,
        },
      })
      return invite
    })
  }

  async revokeInvite(params: { conversationId: string; actorUserId: number; inviteId: string }) {
    const { conversationId, actorUserId, inviteId } = params
    return prisma.$transaction(async tx => {
      await requireOwner(tx, conversationId, actorUserId)
      const invite = await tx.groupInvite.findUnique({ where: { id: inviteId } })
      if (!invite || invite.conversationId !== conversationId) {
        throw new GroupServiceError(404, 'NOT_FOUND', 'Invite not found')
      }
      if (invite.revokedAt) return invite
      return tx.groupInvite.update({
        where: { id: inviteId },
        data: { revokedAt: new Date() },
      })
    })
  }

  async listInvites(params: { conversationId: string; actorUserId: number }) {
    const { conversationId, actorUserId } = params
    return prisma.$transaction(async tx => {
      await requireOwner(tx, conversationId, actorUserId)
      return tx.groupInvite.findMany({
        where: {
          conversationId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      })
    })
  }

  /**
   * Public-ish preview by token. Used by the redeem landing page so the
   * user sees what they're joining before consenting. Caller still has
   * to be an authenticated user (route layer enforces that).
   */
  async previewInvite(token: string) {
    const invite = await prisma.groupInvite.findUnique({
      where: { token },
      include: {
        conversation: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
            type: true,
            participants: {
              where: { leftAt: null },
              select: { userId: true },
            },
          },
        },
      },
    })
    if (!invite) throw new GroupServiceError(404, 'INVITE_NOT_FOUND', 'Invite not found')
    if (invite.revokedAt) throw new GroupServiceError(410, 'INVITE_REVOKED', 'Invite has been revoked')
    if (invite.expiresAt.getTime() <= Date.now()) {
      throw new GroupServiceError(410, 'INVITE_EXPIRED', 'Invite has expired')
    }
    if (invite.useCount >= invite.maxUses) {
      throw new GroupServiceError(410, 'INVITE_EXHAUSTED', 'Invite has been used up')
    }
    return {
      conversationId: invite.conversationId,
      conversation: invite.conversation,
      memberCount: invite.conversation.participants.length,
      maxUses: invite.maxUses,
      useCount: invite.useCount,
      expiresAt: invite.expiresAt,
    }
  }

  /**
   * Redeem an invite token. Adds caller as a MEMBER. Bypasses the
   * `allowGroupInvites` opt-out — clicking the URL is consent — but
   * still enforces blocks, identity existence, and the size cap.
   */
  async redeemInvite(params: { token: string; actorUserId: number }) {
    const { token, actorUserId } = params

    return prisma.$transaction(async tx => {
      const invite = await tx.groupInvite.findUnique({ where: { token } })
      if (!invite) throw new GroupServiceError(404, 'INVITE_NOT_FOUND', 'Invite not found')
      if (invite.revokedAt) throw new GroupServiceError(410, 'INVITE_REVOKED', 'Invite has been revoked')
      if (invite.expiresAt.getTime() <= Date.now()) {
        throw new GroupServiceError(410, 'INVITE_EXPIRED', 'Invite has expired')
      }
      if (invite.useCount >= invite.maxUses) {
        throw new GroupServiceError(410, 'INVITE_EXHAUSTED', 'Invite has been used up')
      }

      const conversationId = invite.conversationId
      const conv = await tx.conversation.findUnique({
        where: { id: conversationId },
        select: { id: true, type: true },
      })
      if (!conv || conv.type !== 'GROUP') {
        throw new GroupServiceError(400, 'NOT_GROUP', 'Conversation is no longer a group')
      }

      // Caller must have a DM identity to receive sealed-per-recipient
      // ciphertext.
      const identity = await tx.dmIdentity.findUnique({
        where: { userId: actorUserId },
        select: { userId: true },
      })
      if (!identity) {
        throw new GroupServiceError(400, 'NO_DM_IDENTITY', 'You must enable DMs before joining a group')
      }

      const active = await tx.conversationParticipant.findMany({
        where: { conversationId, leftAt: null },
        select: { userId: true },
      })
      if (active.some(a => a.userId === actorUserId)) {
        throw new GroupServiceError(400, 'ALREADY_MEMBER', 'You are already in this group.')
      }
      if (active.length >= GROUP_MAX_MEMBERS) {
        throw new GroupServiceError(400, 'GROUP_FULL', `Groups can hold at most ${GROUP_MAX_MEMBERS} members.`)
      }

      const willBeMembers = [...active.map(a => a.userId), actorUserId]
      await assertNoBlocksAcrossSet(willBeMembers)

      const existing = await tx.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId, userId: actorUserId } },
      })
      if (existing) {
        await tx.conversationParticipant.update({
          where: { id: existing.id },
          data: { leftAt: null, joinedAt: new Date(), role: 'MEMBER', status: 'ACCEPTED', unreadCount: 0 },
        })
      } else {
        await tx.conversationParticipant.create({
          data: { conversationId, userId: actorUserId, role: 'MEMBER', status: 'ACCEPTED' },
        })
      }

      await tx.groupInvite.update({
        where: { id: invite.id },
        data: { useCount: { increment: 1 } },
      })

      await writeSystemMessage(tx, conversationId, actorUserId, 'system:added', {
        targetUserIds: [actorUserId],
        viaInviteId: invite.id,
      })

      const conversation = await tx.conversation.findUnique({
        where: { id: conversationId },
        include: memberInclude,
      })
      return { conversation, joinedUserId: actorUserId }
    })
  }

  // ---------- group message helpers ----------

  /**
   * Send a sealed-per-recipient group message. Validates the recipient
   * keyset matches active members (incl. sender) exactly, persists
   * Message + N MessageRecipientPayload rows, and bumps lastMessageAt.
   * Unread-count bump applies to non-sender recipients only.
   *
   * Skips the cross-instance relay (groups are single-node in v1).
   */
  async sendGroupMessage(params: {
    conversationId: string
    senderId: number
    recipientPayloads: Record<number, string>
    contentType?: string
    replyToMessageId?: string
  }) {
    const { conversationId, senderId, recipientPayloads, contentType = 'text', replyToMessageId } = params

    return prisma.$transaction(async tx => {
      const me = await requireParticipant(tx, conversationId, senderId)

      // The participant lookup proved sender is active — but we still
      // need the full active set to validate the keyset.
      const active = await tx.conversationParticipant.findMany({
        where: { conversationId, leftAt: null },
        select: { userId: true },
      })
      const activeIds = active.map(a => a.userId).sort((a, b) => a - b)

      const submittedIds = Object.keys(recipientPayloads).map(k => Number(k)).sort((a, b) => a - b)
      if (
        submittedIds.length !== activeIds.length ||
        submittedIds.some((id, i) => id !== activeIds[i])
      ) {
        throw new GroupServiceError(400, 'KEYSET_MISMATCH', 'recipientPayloads keys must match active group members.', {
          expected: activeIds,
          got: submittedIds,
        })
      }

      if (replyToMessageId) {
        const parent = await tx.message.findUnique({
          where: { id: replyToMessageId },
          select: { conversationId: true },
        })
        if (!parent || parent.conversationId !== conversationId) {
          throw new GroupServiceError(400, 'BAD_REPLY_TARGET', 'Reply target not in this conversation')
        }
      }

      const message = await tx.message.create({
        data: {
          conversationId,
          senderId,
          encryptedPayload: null,
          contentType,
          replyToMessageId: replyToMessageId || null,
        },
        include: {
          sender: {
            include: {
              user: { select: { username: true, displayName: true, avatarUrl: true, defaultAvatarId: true, image: true, tokenId: true } },
            },
          },
        },
      })

      await tx.messageRecipientPayload.createMany({
        data: activeIds.map(uid => ({
          messageId: message.id,
          recipientUserId: uid,
          encryptedPayload: recipientPayloads[uid],
        })),
      })

      await tx.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: message.createdAt, lastMessageId: message.id },
      })

      await tx.conversationParticipant.updateMany({
        where: { conversationId, userId: { not: senderId }, leftAt: null },
        data: { unreadCount: { increment: 1 } },
      })

      void me // suppress unused-warning; participant lookup is the auth gate.
      return message
    })
  }

  /**
   * Per-user toggle for `allowGroupInvites`. Affects future direct adds
   * only; existing memberships are unaffected, and invite-URL redemption
   * still works (explicit consent overrides this flag).
   */
  async setAllowGroupInvites(userId: number, allow: boolean) {
    return prisma.dmIdentity.update({
      where: { userId },
      data: { allowGroupInvites: allow },
      select: { allowGroupInvites: true },
    })
  }
}

export default new GroupService()

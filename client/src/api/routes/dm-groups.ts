import { Router, Request, Response } from 'express'
import groupService, { GroupServiceError } from '../../services/DmService/groupService'
import dmService from '../../services/DmService'
import dmWebSocketService from '../../services/DmService/websocket'
import { requireAuth } from '../middleware/auth'

const router = Router()

function handleError(res: Response, where: string, error: any) {
  if (error instanceof GroupServiceError) {
    return res.status(error.status).json({ error: error.code, message: error.message, ...(error.payload ? { detail: error.payload } : {}) })
  }
  console.error(`${where} error:`, error)
  return res.status(500).json({ error: 'INTERNAL', message: error?.message || 'Internal error' })
}

// ---------- group settings ----------

// PUT /api/dm/groups/settings — flip allowGroupInvites toggle.
router.put('/groups/settings',
  requireAuth({ field: 'userId', verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const { userId, allowGroupInvites } = req.body
      if (typeof allowGroupInvites !== 'boolean') {
        return res.status(400).json({ error: 'allowGroupInvites boolean required' })
      }
      const out = await groupService.setAllowGroupInvites(Number(userId), allowGroupInvites)
      return res.json(out)
    } catch (error: any) {
      return handleError(res, 'PUT /api/dm/groups/settings', error)
    }
  }
)

// ---------- create / read ----------

router.post('/groups',
  requireAuth({ field: 'userId', verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const { userId, memberUserIds, name, avatarUrl } = req.body
      if (!Array.isArray(memberUserIds)) {
        return res.status(400).json({ error: 'memberUserIds[] required' })
      }
      const conv = await groupService.createGroup({
        creatorUserId: Number(userId),
        memberUserIds,
        name,
        avatarUrl,
      })

      // Push to every other participant so their inbox refreshes. Skipping
      // the creator since their POST response already carries the row.
      const others = (conv as any)?.participants?.filter((p: any) => p.userId !== Number(userId)) || []
      for (const p of others) {
        dmWebSocketService.notifyNewConversation(p.userId, conv)
      }
      return res.json(conv)
    } catch (error: any) {
      return handleError(res, 'POST /api/dm/groups', error)
    }
  }
)

router.get('/groups/:id',
  requireAuth({ lookup: async (req) => {
    const userId = req.query.userId
    return userId ? Number(userId) : undefined
  }, verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const conv = await groupService.getGroup({
        conversationId: req.params.id,
        actorUserId: Number(req.query.userId),
      })
      return res.json(conv)
    } catch (error: any) {
      return handleError(res, 'GET /api/dm/groups/:id', error)
    }
  }
)

// ---------- members ----------

router.post('/groups/:id/members',
  requireAuth({ field: 'userId', verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const { userId, targetUserIds } = req.body
      if (!Array.isArray(targetUserIds)) {
        return res.status(400).json({ error: 'targetUserIds[] required' })
      }
      const conv = await groupService.addMembers({
        conversationId: req.params.id,
        actorUserId: Number(userId),
        targetUserIds,
      })

      // Notify newly-added users (their inbox should pick up the row);
      // notify existing members via the conversation room.
      for (const t of targetUserIds) {
        dmWebSocketService.notifyNewConversation(Number(t), conv)
      }
      dmWebSocketService.broadcastConversationUpdate(req.params.id, {
        kind: 'member-added',
        targetUserIds: targetUserIds.map((t: any) => Number(t)),
      })
      return res.json(conv)
    } catch (error: any) {
      return handleError(res, 'POST /api/dm/groups/:id/members', error)
    }
  }
)

router.delete('/groups/:id/members/:userId',
  requireAuth({ field: 'actorUserId', verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const { actorUserId } = req.body
      const conv = await groupService.removeMember({
        conversationId: req.params.id,
        actorUserId: Number(actorUserId),
        targetUserId: Number(req.params.userId),
      })
      dmWebSocketService.broadcastConversationUpdate(req.params.id, {
        kind: 'member-removed',
        targetUserId: Number(req.params.userId),
      })
      return res.json(conv)
    } catch (error: any) {
      return handleError(res, 'DELETE /api/dm/groups/:id/members/:userId', error)
    }
  }
)

router.post('/groups/:id/leave',
  requireAuth({ field: 'userId', verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.body
      const result = await groupService.leaveGroup({
        conversationId: req.params.id,
        actorUserId: Number(userId),
      })
      dmWebSocketService.broadcastConversationUpdate(req.params.id, {
        kind: 'member-removed',
        targetUserId: Number(userId),
        newOwnerUserId: result.newOwnerUserId,
      })
      return res.json(result)
    } catch (error: any) {
      return handleError(res, 'POST /api/dm/groups/:id/leave', error)
    }
  }
)

// PATCH /api/dm/groups/:id — owner-only metadata edit. We can't extract
// the actor from the path, so callers MUST pass userId in the body.
router.patch('/groups/:id',
  requireAuth({ field: 'userId', verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const { userId, name, avatarUrl } = req.body
      const conv = await groupService.updateGroup({
        conversationId: req.params.id,
        actorUserId: Number(userId),
        name,
        avatarUrl,
      })
      dmWebSocketService.broadcastConversationUpdate(req.params.id, {
        kind: 'conversation-updated',
        name: (conv as any).name,
        avatarUrl: (conv as any).avatarUrl,
      })
      return res.json(conv)
    } catch (error: any) {
      return handleError(res, 'PATCH /api/dm/groups/:id', error)
    }
  }
)

// ---------- invites ----------

router.post('/groups/:id/invites',
  requireAuth({ field: 'userId', verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const { userId, expiresAt, maxUses } = req.body
      const expiresDate = expiresAt ? new Date(expiresAt) : null
      if (!expiresDate || isNaN(expiresDate.getTime())) {
        return res.status(400).json({ error: 'expiresAt (ISO date) required' })
      }
      const invite = await groupService.mintInvite({
        conversationId: req.params.id,
        actorUserId: Number(userId),
        expiresAt: expiresDate,
        maxUses: Number(maxUses),
      })
      return res.json(invite)
    } catch (error: any) {
      return handleError(res, 'POST /api/dm/groups/:id/invites', error)
    }
  }
)

router.get('/groups/:id/invites',
  requireAuth({ lookup: async (req) => {
    const userId = req.query.userId
    return userId ? Number(userId) : undefined
  }, verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const invites = await groupService.listInvites({
        conversationId: req.params.id,
        actorUserId: Number(req.query.userId),
      })
      return res.json({ invites })
    } catch (error: any) {
      return handleError(res, 'GET /api/dm/groups/:id/invites', error)
    }
  }
)

router.delete('/groups/:id/invites/:inviteId',
  requireAuth({ field: 'userId', verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.body
      const out = await groupService.revokeInvite({
        conversationId: req.params.id,
        actorUserId: Number(userId),
        inviteId: req.params.inviteId,
      })
      return res.json(out)
    } catch (error: any) {
      return handleError(res, 'DELETE /api/dm/groups/:id/invites/:inviteId', error)
    }
  }
)

// Auth-gated preview — caller must be signed in but not yet a member.
router.get('/groups/join/:token',
  requireAuth({ anySession: true }),
  async (req: Request, res: Response) => {
    try {
      const preview = await groupService.previewInvite(req.params.token)
      return res.json(preview)
    } catch (error: any) {
      return handleError(res, 'GET /api/dm/groups/join/:token', error)
    }
  }
)

router.post('/groups/join/:token',
  requireAuth({ field: 'userId', verifyOwnership: true }),
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.body
      const out = await groupService.redeemInvite({
        token: req.params.token,
        actorUserId: Number(userId),
      })
      if (out.conversation) {
        const others = (out.conversation as any).participants?.filter((p: any) => p.userId !== Number(userId)) || []
        for (const p of others) {
          dmWebSocketService.notifyNewConversation(p.userId, out.conversation)
        }
        // Joiner gets a direct push so their other tabs / sessions update.
        dmWebSocketService.notifyNewConversation(Number(userId), out.conversation)
        dmWebSocketService.broadcastConversationUpdate(out.conversation.id, {
          kind: 'member-added',
          targetUserIds: [Number(userId)],
        })
      }
      return res.json(out)
    } catch (error: any) {
      return handleError(res, 'POST /api/dm/groups/join/:token', error)
    }
  }
)

// Suppress unused-import warning while keeping the symbol available for
// future per-conversation read paths that don't yet exist on dmService.
void dmService

export default router

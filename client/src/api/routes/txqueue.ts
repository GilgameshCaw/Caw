import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { requireAuth } from '../middleware/auth'
import { countManager } from '../../services/CountManager'
import { decompressActionText } from '../../utils/decompressActionText'

const router = Router()

/**
 * Get status of specific txQueue entries.
 *
 * Auth: the caller's session must include each entry's senderId in
 * authorizedTokenIds. Without this, anyone could enumerate sequential
 * txQueue ids and dump signed-action payloads (incl. recipients,
 * amounts, scheduled tips) for failed entries. Audit fix 2026-05-09
 * (Round 5 API MED-1).
 */
router.get('/status', requireAuth({ anySession: true }), async (req, res) => {
  try {
    const { ids } = req.query

    if (!ids || typeof ids !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid ids parameter' })
    }

    const txQueueIds = ids.split(',').map(id => parseInt(id, 10)).filter(id => !isNaN(id))

    if (txQueueIds.length === 0) {
      return res.status(400).json({ error: 'No valid IDs provided' })
    }

    const authorized = new Set((req.sessionData?.authorizedTokenIds || []) as number[])

    const txQueueEntries = await prisma.txQueue.findMany({
      where: {
        id: { in: txQueueIds }
      },
      select: {
        id: true,
        status: true,
        reason: true,
        senderId: true,
        payload: true,
        batchId: true,
      }
    })

    res.json({
      statuses: txQueueEntries
        .filter(entry => authorized.has(entry.senderId))
        .map(entry => ({
          id: entry.id,
          status: entry.status,
          reason: entry.reason,
          // batchId travels on every row so the FE retry path can find
          // sibling thread members on a single TxQueue failure (the user
          // doesn't have to retry each post in the thread separately).
          batchId: entry.batchId,
          // Include senderId and payload for failed entries so the client can auto-retry
          ...(entry.status === 'failed' ? { senderId: entry.senderId, payload: entry.payload } : {}),
        }))
    })
  } catch (err: any) {
    console.error('GET /api/txqueue/status error', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

/**
 * Return every TxQueue row that shares a batchId, regardless of status.
 * The FE uses this when a batched action (thread post) fails so it can
 * retry the WHOLE thread atomically — not just the failed-and-clicked
 * row. Without this, the user would have to manually re-trigger each
 * thread member individually, and historically the sibling members
 * would silently stay dead in the queue.
 *
 * Caller must own the senderId (anySession auth + payload owner check).
 * Bounded at the natural batch cap (256 actions per batch on the
 * /api/actions/batch endpoint).
 */
router.get('/batch/:batchId',
  requireAuth({ anySession: true }),
  async (req, res) => {
  try {
    const batchId = parseInt(req.params.batchId, 10)
    if (isNaN(batchId)) {
      return res.status(400).json({ error: 'Invalid batchId' })
    }

    const entries = await prisma.txQueue.findMany({
      where: { batchId },
      select: {
        id: true,
        senderId: true,
        cawonce: true,
        status: true,
        reason: true,
        payload: true,
        createdAt: true,
      },
      orderBy: { cawonce: 'asc' },
    })

    if (entries.length === 0) {
      return res.json({ entries: [] })
    }

    // Authorization: every row in a batch shares the same senderId
    // (enforced at /api/actions/batch creation time), so check the
    // first row's owner against the caller's authorized tokens.
    const authorized = new Set((req.sessionData?.authorizedTokenIds || []) as number[])
    if (!authorized.has(entries[0].senderId)) {
      return res.status(403).json({ error: 'Not authorized for this batch' })
    }

    res.json({ entries })
  } catch (err: any) {
    console.error('GET /api/txqueue/batch error', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

/**
 * Resolve whether a failed TxQueue row's action actually landed on chain
 * (i.e. our signed payload is already represented by an indexed Action row
 * with matching content). Used by the FE BEFORE it auto-retries a
 * "Cawonce already used" failure — if the action already succeeded via a
 * peer mirror or a same-content earlier submission, retrying would create
 * a duplicate post at a fresh cawonce.
 *
 * Mirrors the validator's resolveCawonceUsed comparison field-by-field
 * (actionType, receiverId, receiverCawonce, decompressed text). DB-only;
 * per project_no_rpc_in_request_handlers.md API request handlers don't
 * call chain RPC. If the Action row isn't indexed yet, returns
 * `{ landed: 'unknown', reason: 'no-action-row' }` and the FE should
 * apply its own delay heuristic before retrying.
 *
 * Auth: caller must own the row's senderId (anySession + per-row check).
 *
 * Response shape:
 *   { landed: 'ours' }     — exact same action is on chain; safe to mark done
 *   { landed: 'collision' } — slot used by a DIFFERENT action; retry needed
 *   { landed: 'unknown', reason: '...' } — can't tell yet (indexer lag, etc.)
 */
router.get('/check-landed/:id',
  requireAuth({ anySession: true }),
  async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid id' })
    }

    const row = await prisma.txQueue.findUnique({
      where: { id },
      select: { senderId: true, cawonce: true, payload: true },
    })
    if (!row) {
      return res.status(404).json({ error: 'Not found' })
    }

    const authorized = new Set((req.sessionData?.authorizedTokenIds || []) as number[])
    if (!authorized.has(row.senderId)) {
      return res.status(403).json({ error: 'Not authorized for this row' })
    }

    if (row.cawonce == null) {
      return res.json({ landed: 'unknown', reason: 'no-cawonce-on-row' })
    }

    const data = (row.payload as any)?.data
    if (!data) {
      return res.json({ landed: 'unknown', reason: 'no-payload-data' })
    }

    const existingAction = await prisma.action.findFirst({
      where: { senderId: row.senderId, cawonce: row.cawonce },
    })
    if (!existingAction) {
      // Action row not yet indexed locally. Could mean:
      //   (a) the slot really hasn't been used (the validator's
      //       "Cawonce already used" rejection might be from a peer
      //       mirror that landed an action we haven't indexed yet).
      //   (b) the slot wasn't used at all and the validator's
      //       rejection was wrong (rare — chain bitmap doesn't lie).
      // Either way the FE shouldn't assume safe-to-retry yet. The
      // 'unknown' verdict lets the FE choose: wait a few seconds and
      // re-check, OR fall back to a chain bitmap probe via wagmi/viem
      // (which goes through /api/rpc/* so we still benefit from the
      // proxy cache).
      return res.json({ landed: 'unknown', reason: 'no-action-row' })
    }

    const ex = existingAction.data as any
    const dataTextPlain = decompressActionText(data.text)
    const sameAction =
      Number(ex?.actionType ?? -1) === Number(data.actionType) &&
      Number(ex?.receiverId ?? -1) === Number(data.receiverId ?? 0) &&
      Number(ex?.receiverCawonce ?? -1) === Number(data.receiverCawonce ?? 0) &&
      (ex?.text ?? '') === dataTextPlain

    return res.json({ landed: sameAction ? 'ours' : 'collision' })
  } catch (err: any) {
    console.error('GET /api/txqueue/check-landed error', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

/**
 * Return failed "Cawonce already used" TxQueue entries for a sender
 * (last 24h only). Older entries are escalated to ACTION_FAILED
 * notifications by the DataCleaner.
 */
router.get('/failed-cawonce/:senderId',
  requireAuth({ lookup: async (req) => Number(req.params.senderId) }),
  async (req, res) => {
  try {
    const senderId = parseInt(req.params.senderId, 10)
    if (isNaN(senderId)) {
      return res.status(400).json({ error: 'Invalid senderId' })
    }

    const entries = await prisma.txQueue.findMany({
      where: {
        senderId,
        status: 'failed',
        reason: 'Cawonce already used',
      },
      select: {
        id: true,
        senderId: true,
        payload: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 5,
    })

    // Only return entries from the last 24 hours — older ones are escalated
    // to ACTION_FAILED notifications by the DataCleaner.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const retryable = entries.filter(e => e.updatedAt > cutoff)

    res.json({
      entries: retryable.map(e => ({
        id: e.id,
        senderId: e.senderId,
        payload: e.payload,
      })),
    })
  } catch (err: any) {
    console.error('GET /api/txqueue/failed-cawonce error', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

/**
 * POST /api/txqueue/:id/cancel — try to cancel an in-flight action
 * before the validator picks it up.
 *
 * The race window is small: the validator polls every couple of
 * seconds, then atomically flips a batch of rows from 'pending' to
 * 'processing'. Our cancel uses the same conditional-where pattern
 * (`updateMany where: { status: 'pending' }`) so exactly one of cancel
 * vs validator-pickup wins. If we lose the race we return 409 and
 * the caller falls back to letting the action go through.
 *
 * On a successful cancel we also unwind the optimistic API-side row
 * the original /api/actions handler wrote (currently only Like —
 * other action types either don't write optimistic rows or already
 * have their own rollback path on the failure side).
 */
router.post(
  '/:id/cancel',
  requireAuth({ anySession: true }),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' })

      const entry = await prisma.txQueue.findUnique({
        where: { id },
        select: { id: true, senderId: true, status: true, payload: true },
      })
      if (!entry) return res.status(404).json({ error: 'TxQueue entry not found' })

      const authorized = new Set((req.sessionData?.authorizedTokenIds || []) as number[])
      if (!authorized.has(entry.senderId)) {
        return res.status(403).json({ error: 'Forbidden' })
      }

      // Atomic flip: only succeeds if the row is still 'pending'. Any
      // other status (processing, validated, included, failed, …) means
      // we lost the race and the caller should treat the action as
      // committed.
      const flipped = await prisma.txQueue.updateMany({
        where: { id, status: 'pending' },
        data: { status: 'cancelled', reason: 'Cancelled by sender' },
      })
      if (flipped.count === 0) {
        return res.status(409).json({ error: 'too_late', message: 'Action already picked up by validator' })
      }

      // Roll back the optimistic Like row /api/actions wrote when this
      // was a 'like' action. Other action types either don't have an
      // optimistic API-side row or have their own teardown elsewhere
      // (caw rows live in pending/failed status that the indexer
      // reconciles; pin rows are handled by the Pin lifecycle).
      const data = (entry.payload as any)?.data || {}
      const actionType = Number(data.actionType)
      if (actionType === 1 /* LIKE */) {
        const targetCaw = await prisma.caw.findFirst({
          where: { userId: data.receiverId, cawonce: data.receiverCawonce },
          select: { id: true },
        })
        if (targetCaw) {
          await prisma.$transaction(async (tx: any) => {
            const existing = await tx.like.findUnique({
              where: { userId_cawId: { userId: entry.senderId, cawId: targetCaw.id } },
              select: { id: true, pending: true },
            })
            // Only undo if the row is still pending — a confirmed like
            // for the same (user, caw) means the indexer raced ahead
            // and we should leave it alone.
            if (existing && existing.pending) {
              await tx.like.delete({ where: { id: existing.id } })
              await countManager.onLikeRemoved(tx, { cawId: targetCaw.id, userId: entry.senderId })
            }
          })
        }
      }

      return res.json({ ok: true })
    } catch (err: any) {
      console.error('POST /api/txqueue/:id/cancel error', err)
      res.status(500).json({ error: 'Internal error' })
    }
  }
)

export default router
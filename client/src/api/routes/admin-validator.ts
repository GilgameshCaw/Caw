import { Router } from 'express'
import { requireAdmin } from '../middleware/auth'
import { triggerImmediateValidatorPoll } from '../../services/ValidatorService'
import { prisma } from '../../prismaClient'

const router = Router()
router.use(requireAdmin)

/**
 * POST /api/admin/validator/execute-batch-now
 *
 * Tell the validator to bypass its normal batch-accumulation wait and
 * process every pending TxQueue row on its next tick (which we also
 * fire immediately rather than waiting for the next setTimeout). Used
 * by the "Execute batch now" admin button on the DatabaseAdmin page.
 *
 * The validator only runs on nodes that have it enabled; on api-only
 * nodes the trigger returns 200 with triggered=false and the admin UI
 * surfaces that as "no validator on this node."
 */
router.post('/execute-batch-now', async (_req, res) => {
  try {
    const pendingCount = await prisma.txQueue.count({
      where: { status: { in: ['pending', 'awaiting_indexer'] } },
    })
    const { triggered, reason } = triggerImmediateValidatorPoll()
    res.json({ ok: true, triggered, reason, pendingCount })
  } catch (err: any) {
    console.error('[admin-validator] execute-batch-now failed:', err)
    res.status(500).json({ ok: false, error: err?.message || 'Failed to trigger batch' })
  }
})

export default router

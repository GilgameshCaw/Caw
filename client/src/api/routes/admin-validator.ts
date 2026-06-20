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

/**
 * GET /api/admin/validator/relay-accounting
 *
 * The passkey-wallet relay ledger: per-tx GAS the relayer SPENT vs the FEE it
 * RECEIVED (in CAW or ETH), so the operator can confirm the validator isn't
 * losing money relaying executeBatch (withdraw / deposit / zap).
 *
 * Everything is valued in ETH wei. A CAW fee is converted to ETH using the
 * cawPerEthWei rate snapshotted at relay time (feeCaw × ethPerCaw / 1e18), so the
 * net is apples-to-apples against gas. Rows with no rate snapshot (rare CAW-price
 * outage) count their gas as spend but contribute 0 received — conservative, so a
 * missing rate can only make the ledger look WORSE, never falsely profitable.
 *
 * Query: ?limit (rows, default 100, max 500) & ?sinceDays (default 30).
 */
router.get('/relay-accounting', async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))
    const sinceDays = Math.min(365, Math.max(1, Number(req.query.sinceDays) || 30))
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)

    const rows = await prisma.relayExecution.findMany({
      where: { relayedAt: { gte: since } },
      orderBy: { relayedAt: 'desc' },
      take: limit,
    })

    // Aggregate over the WHOLE window (not just the returned page) so totals are
    // honest even when limit truncates the row list.
    const all = await prisma.relayExecution.findMany({
      where: { relayedAt: { gte: since } },
      select: { gasSpentWei: true, feeCurrency: true, feeReceivedWei: true, cawPerEthWei: true },
    })

    const ONE = 10n ** 18n
    let gasSpentWei = 0n
    let receivedEthWei = 0n         // ETH fees, directly
    let receivedCawAsEthWei = 0n    // CAW fees valued in ETH via the snapshot
    let receivedCawWei = 0n         // raw CAW received (for display)
    let unvaluedCawRows = 0         // CAW fees with no rate snapshot (counted as 0 received)

    const big = (s: string | null | undefined): bigint => {
      try { return BigInt(s ?? '0') } catch { return 0n }
    }

    for (const r of all) {
      gasSpentWei += big(r.gasSpentWei)
      if (r.feeCurrency === 'ETH') {
        receivedEthWei += big(r.feeReceivedWei)
      } else {
        const caw = big(r.feeReceivedWei)
        receivedCawWei += caw
        const rate = big(r.cawPerEthWei) // CAW per 1 ETH, in wei
        if (rate > 0n) {
          // ethValue = cawAmount / cawPerEth = caw × 1e18 / cawPerEthWei
          receivedCawAsEthWei += (caw * ONE) / rate
        } else {
          unvaluedCawRows += 1
        }
      }
    }

    const totalReceivedEthWei = receivedEthWei + receivedCawAsEthWei
    const netEthWei = totalReceivedEthWei - gasSpentWei

    res.json({
      ok: true,
      sinceDays,
      count: all.length,
      // All ETH-wei decimal strings (FE formats with the live ETH/USD price).
      gasSpentWei: gasSpentWei.toString(),
      receivedEthWei: receivedEthWei.toString(),
      receivedCawWei: receivedCawWei.toString(),
      receivedCawAsEthWei: receivedCawAsEthWei.toString(),
      totalReceivedEthWei: totalReceivedEthWei.toString(),
      netEthWei: netEthWei.toString(),
      profitable: netEthWei >= 0n,
      unvaluedCawRows,
      rows: rows.map(r => ({
        txHash: r.txHash,
        smartEoa: r.smartEoa,
        kind: r.kind,
        gasSpentWei: r.gasSpentWei,
        feeCurrency: r.feeCurrency,
        feeReceivedWei: r.feeReceivedWei,
        relayedAt: r.relayedAt,
      })),
    })
  } catch (err: any) {
    console.error('[admin-validator] relay-accounting failed:', err)
    res.status(500).json({ ok: false, error: err?.message || 'Failed to load relay accounting' })
  }
})

export default router

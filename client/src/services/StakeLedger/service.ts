// Background service that runs the StakeLedger daily reconciler.
// The snapshotter itself lives inline inside ActionProcessor and
// doesn't need a service of its own — it's purely event-driven. The
// reconciler is a cron, hence the wrapper.

import { z } from 'zod'
import type { Service } from '../../Service'
import { runDailyReconciliation } from './dailyReconciler'

const Config = z.object({
  // 24h between runs by default; configurable for testing.
  intervalMs: z.number().int().positive().optional().default(24 * 60 * 60 * 1000),
  // Skip the initial run on boot so a process restart doesn't spam the
  // RPC during a deploy.
  skipFirstRun: z.boolean().optional().default(false),
})

export const stakeLedgerReconcilerService: Service = {
  name: 'StakeLedgerReconciler',

  validateConfig(cfg) {
    const res = Config.safeParse(cfg)
    return res.success ? [] : res.error.errors.map(e => new Error(e.message))
  },

  start(cfg, ctx) {
    const { intervalMs, skipFirstRun } = Config.parse(cfg)
    let stopped = false
    let timer: NodeJS.Timeout | null = null
    let inFlight: Promise<unknown> | undefined

    // The cron only fires once a day; the watchdog timeout has to be
    // longer than the interval. 25h gives a 1h grace.
    ctx.declareLoop('reconcile', intervalMs + 60 * 60 * 1000)

    function tick() {
      timer = null
      if (stopped) return
      inFlight = runDailyReconciliation().catch(err => {
        console.error('[StakeLedgerReconciler] run failed:', err)
      }).finally(() => {
        inFlight = undefined
        if (stopped) return
        ctx.heartbeat('reconcile')
        timer = setTimeout(tick, intervalMs)
      })
    }

    const started = (async () => {
      // Heartbeat once on boot so the watchdog doesn't immediately
      // declare us dead before the first interval fires.
      ctx.heartbeat('reconcile')
      if (skipFirstRun) {
        timer = setTimeout(tick, intervalMs)
      } else {
        // Defer slightly so the rest of the process can finish boot.
        timer = setTimeout(tick, 30_000)
      }
    })()

    return {
      started,
      async stop() {
        stopped = true
        if (timer) clearTimeout(timer)
        await inFlight
      },
      stats: async () => 'idle',
    }
  },
}

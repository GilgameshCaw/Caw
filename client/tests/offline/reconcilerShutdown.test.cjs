const { it } = require('node:test')
const { loadSource } = require('./loadSource.cjs')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const load = (_file, imports) => loadSource(join(__dirname, '../../src/services/StakeLedger/service.ts'), imports)


it('waits for active reconciliation on stop and schedules no further run', async t => {
  const work = Promise.withResolvers()
  const timeouts = new Map()
  const setting = { int: () => setting, positive: () => setting, optional: () => setting, default: () => setting }
  t.mock.method(global, 'setTimeout', (fn, ms) => { timeouts.set(ms, fn); return ms })
  t.mock.method(global, 'clearTimeout', ms => timeouts.delete(ms))
  const { stakeLedgerReconcilerService } = load('service.ts', {
    zod: { z: { number: () => setting, boolean: () => setting, object: () => ({ parse: value => value }) } },
    './dailyReconciler': { runDailyReconciliation: () => work.promise },
  })
  const instance = stakeLedgerReconcilerService.start({ intervalMs: 123, skipFirstRun: true }, {
    declareLoop() {}, heartbeat() {},
  })
  await instance.started
  const tick = timeouts.get(123)
  timeouts.delete(123)
  tick()
  let stopped = false
  const stopping = instance.stop().then(() => { stopped = true })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(stopped, false)
  } finally {
    work.resolve()
    await stopping
  }
  assert.equal(timeouts.size, 0)
})

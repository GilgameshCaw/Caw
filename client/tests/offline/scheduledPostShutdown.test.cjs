const { it } = require('node:test')
const { loadSource } = require('./loadSource.cjs')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const turn = () => new Promise(resolve => setImmediate(resolve))
const load = (_path, imports) => loadSource(join(__dirname, '../../src/services/ScheduledPostProcessor/index.ts'), imports)

it('cancels the interval and drains all active ticks before closing the logger and Prisma', async t => {
  const reads = [Promise.withResolvers(), Promise.withResolvers()]
  let readCount = 0
  const order = []
  const intervals = new Map()
  t.mock.method(global, 'setInterval', (fn, ms) => { intervals.set(ms, fn); return ms })
  t.mock.method(global, 'clearInterval', ms => intervals.delete(ms))
  const { scheduledPostProcessorService } = load('services/ScheduledPostProcessor/index.ts', {
    '../../prismaClient': { prisma: {
      scheduledCaw: { findMany: () => reads[readCount++].promise },
      $disconnect: async () => { order.push('disconnect') },
    } },
    '../../utils/scheduledPostLogger': { scheduledPostLogger: {
      log() {}, error() {}, close() { order.push('close logger') },
    } },
    '../../tools/hashtags': {},
    '../CountManager': {},
    smltxt: {},
  })
  const instance = scheduledPostProcessorService.start({}, { declareLoop() {}, heartbeat() {} })
  await instance.started
  const tick = intervals.get(60000)
  const activeTick = tick()
  const stopping = instance.stop()
  try {
    await turn()
    assert.equal(intervals.size, 0)
    assert.deepEqual(order, [])
    reads[0].resolve([])
    await turn()
    assert.deepEqual(order, [])
    assert.equal(readCount, 2)
  } finally {
    reads.forEach(read => read.resolve([]))
    await stopping
    await activeTick
  }
  assert.deepEqual(order, ['close logger', 'disconnect'])
})

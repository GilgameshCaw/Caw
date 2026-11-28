const { it } = require('node:test')
const { loadSource } = require('./loadSource.cjs')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { join } = require('node:path')

const source = join(__dirname, '../../src/services/ActionProcessor/index.ts')
const raw = {
  id: 42, chainId: 1, blockNumber: 1n, logIndex: 0, transactionHash: 'test', topics: [],
  data: [{ actionType: 0, senderId: 1 }],
}
const turn = () => new Promise(resolve => setImmediate(resolve))

function fixture(t, overrides = {}) {
  const redis = new EventEmitter()
  redis.subscribe = async () => {}
  redis.quit = async () => {}
  redis.disconnect = () => {}
  const intervals = new Map()
  t.mock.method(global, 'setInterval', (fn, ms) => { intervals.set(ms, fn); return ms })
  t.mock.method(global, 'clearInterval', ms => intervals.delete(ms))
  const prisma = {
    $connect: async () => {},
    $disconnect: async () => {},
    action: { findFirst: async () => null },
    rawEvent: { findMany: async () => [], findUnique: async () => raw },
    chainData: { findUnique: async () => null, upsert: async () => {} },
    $transaction: async work => work({}),
    ...overrides.prisma,
  }
  const mod = loadSource(source, {
    '../../prismaClient': { prisma },
    'ioredis': class { constructor() { return redis } },
    'zod': { z: {
      string: () => ({ optional: () => ({ default: () => ({}) }) }),
      object: () => ({ parse: value => value }),
    } },
    '@prisma/client': {},
    './actionCreation': {
      createOrFindAction: async () => ({ action: {}, shouldProcessDomain: false }),
      ...overrides.actionCreation,
    },
    './domainProcessor': { resolveActionUsers: async () => ({}), ...overrides.domainProcessor },
    '../UserService': { StaleTokenError: class extends Error {} },
    './actionHandlers': { CawNotFoundError: class extends Error {} },
    '../../abi/addresses': { CAW_ACTIONS_ADDRESS: 'test' },
    '../../utils/trace': { span: (_name, _attrs, work) => work(), ...overrides.trace },
    '../../abi/getActionType': () => 'CAW',
    '../StakeLedger': { verifyMultiplier: async () => {}, recordAction: async () => {} },
  })
  const service = mod.actionProcessorService
  const instance = service.start({ redisUrl: 'mock' }, { declareLoop() {}, heartbeat() {} })
  return { instance, redis, intervals }
}



it('lets live work finish before Prisma disconnects and skips queued work after stop', async t => {
  const order = []
  const entered = Promise.withResolvers()
  const finish = Promise.withResolvers()
  const { instance, redis } = fixture(t, {
    domainProcessor: {
      resolveActionUsers: async () => {
        order.push('lookup')
        entered.resolve()
        await finish.promise
        order.push('lookup finished')
        return {}
      },
    },
    prisma: { $disconnect: async () => { order.push('disconnect') } },
  })
  await instance.started
  redis.emit('message', 'raws', '42')
  await entered.promise
  redis.emit('message', 'raws', '43')
  const stopping = instance.stop()
  try {
    await turn()
    assert.deepEqual(order, ['lookup'])
  } finally {
    finish.resolve()
    await stopping
  }
  assert.deepEqual(order, ['lookup', 'lookup finished', 'disconnect'])
})

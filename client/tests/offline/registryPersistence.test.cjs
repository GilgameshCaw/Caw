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

it('preserves a new retry entry across registry read and write failures', async t => {
  let reads = 0
  let writes = 0
  const existing = { attempts: 2, nextRetryAt: Date.now() + 600000, lastError: 'existing', firstFailedAt: 1 }
  let stored = { 11: existing }
  const { instance, intervals } = fixture(t, {
    trace: { span: async () => { throw Error('temporary event failure') } },
    prisma: {
      rawEvent: { findMany: async ({ where }) => where.id.gt < raw.id ? [raw] : [] },
      chainData: {
        findUnique: async () => {
          if (++reads === 1) throw Error('registry read unavailable')
          return { value: structuredClone(stored) }
        },
        upsert: async ({ update }) => {
          if (++writes === 1) throw Error('registry write unavailable')
          stored = structuredClone(update.value)
        },
      },
    },
  })
  try {
    await instance.started
    intervals.get(60000)()
    await turn()
    intervals.get(60000)()
    await turn()
    assert.deepEqual(stored[11], existing)
    assert.equal(stored[42]?.attempts, 1)
    assert.equal(stored[42]?.lastError, 'temporary event failure')
  } finally {
    await instance.stop()
  }
})

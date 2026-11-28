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


for (const code of ['P2034', 'P2024']) {
  it(`retries only the Action transaction on ${code}, then applies domain effects once`, async t => {
    let transactions = 0
    let effects = 0
    let actionWrites = 0
    const { instance } = fixture(t, {
      prisma: {
        rawEvent: { findMany: async ({ where }) => where.id.gt < raw.id ? [raw] : [] },
        $transaction: async work => {
          if (++transactions === 1) throw Object.assign(Error('temporary DB failure'), { code })
          return work({})
        },
      },
      actionCreation: {
        createOrFindAction: async () => { actionWrites++; return { action: {}, shouldProcessDomain: true } },
        ensureActionExists: async (_tx, _rawId, action) => action,
      },
      domainProcessor: { processDomainEffects: async () => { effects++ } },
    })
    try {
      await instance.started
      // Failed Action attempt, successful retry, domain effects, ledger snapshot.
      assert.deepEqual({ transactions, actionWrites, effects }, { transactions: 4, actionWrites: 1, effects: 1 })
    } finally {
      await instance.stop()
    }
  })
}

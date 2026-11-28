const { it } = require('node:test')
const { loadSource } = require('./loadSource.cjs')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const source = join(__dirname, '../../src/services/DepositWatcher/index.ts')
const turn = () => new Promise(resolve => setImmediate(resolve))

function fixture(t, checkpoint) {
  const timers = new Map()
  const ranges = []
  const order = []
  const setting = { int: () => setting, positive: () => setting, optional: () => setting, default: () => setting }
  t.mock.method(global, 'setTimeout', (fn, ms) => { timers.set(ms, fn); return ms })
  t.mock.method(global, 'clearTimeout', ms => timers.delete(ms))
  const mod = loadSource(source, {
    'dotenv/config': {},
    zod: { z: { number: () => setting, string: () => setting, object: () => ({ parse: value => value }) } },
    ethers: { ethers: { Contract: class {
      filters = { Deposited: () => 'mock-filter' }
      async queryFilter(_filter, from, to) { ranges.push([from, to]); return [] }
    } } },
    ioredis: class {
      async get() { return '5' }
      async set(_key, block) { return checkpoint(block) }
      async quit() { order.push('quit') }
    },
    '../../utils/rpcProvider': {
      getL1HttpRpcUrl: () => 'mock',
      getL1HttpRpcUrls: () => ['mock'],
      makeVerifiedJsonRpcProvider: async () => {},
      makeResilientHttpProvider: () => ({ get: () => ({ getBlockNumber: async () => 7 }), reportError() {} }),
      redactRpcUrl: () => 'mock',
    },
    '../../prismaClient': { prisma: { $connect: async () => {} } },
    '../../abi/addresses': { CAW_NAMES_ADDRESS: 'mock-contract' },
    '../StakeLedger': {},
    '../../utils/networkId': { getNetworkId: () => 1 },
  })
  const { depositWatcherService } = mod
  const instance = depositWatcherService.start({ chainId: 1, pollIntervalMs: 123, maxBlocksPerPoll: 5 }, {
    declareLoop() {}, heartbeat() {},
  })
  return { instance, timers, ranges, order }
}


it('waits for the active checkpoint write before closing Redis', async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const { instance, timers, order } = fixture(t, async () => {
    order.push('write')
    entered.resolve()
    await release.promise
    order.push('written')
  })
  await instance.started
  await entered.promise
  const stop = instance.stop()
  try {
    await turn()
    assert.deepEqual(order, ['write'])
    assert.equal(instance.stop(), stop)
  } finally {
    release.resolve()
    await stop
  }
  assert.deepEqual(order, ['write', 'written', 'quit'])
  assert.equal(timers.size, 0)
})

const { it } = require('node:test')
const { loadSource } = require('./loadSource.cjs')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const source = join(__dirname, '../../src/runServices.ts')
const turn = () => new Promise(resolve => setImmediate(resolve))

function fixture(t, names) {
  const order = []
  const handlers = new Map()
  const imports = {
    'node:process': { on: (signal, handler) => handlers.set(signal, handler), exit: code => order.push(`exit:${code}`) },
    zod: { z: { object() {}, string() {}, optional() {}, unknown() {}, array() {} } },
    './tools/delay': () => new Promise(() => {}),
    './prismaClient': { shutdownPrisma: async () => { order.push('prisma shutdown') } },
  }
  const stopHooks = new Map()
  for (const [file, name] of Object.entries(names)) {
    imports['./services/' + file] = { [name]: {
      name,
      validateConfig: () => [],
      start: () => ({ started: Promise.resolve(), stop: () => stopHooks.get(name)?.() }),
    } }
  }
  const watchdogTimers = []
  t.mock.method(global, 'setTimeout', (fn, ms) => {
    watchdogTimers.push({ fn, ms })
    return { unref() {} }
  })
  const { default: run } = loadSource(source, imports)
  return { handlers, order, stopHooks, watchdogTimers, run }
}

const services = {
  RawEventsGatherer: 'rawEventsGathererService',
  ActionProcessor: 'actionProcessorService',
  ValidatorService: 'validatorService',
  FrontEnd: 'frontEndService',
  Api: 'apiService',
  DataCleaner: 'dataCleanerService',
  ScheduledPostProcessor: 'scheduledPostProcessorService',
  InstanceRegistryService: 'instanceRegistryService',
  ChainSyncService: 'chainSyncService',
  MarketplaceIndexerService: 'marketplaceIndexerService',
  NftTransferWatcher: 'nftTransferWatcherService',
  'StakeLedger/service': 'stakeLedgerReconcilerService',
  DepositWatcher: 'depositWatcherService',
  LzRelayService: 'lzRelayService',
  SponsorRepayIndexer: 'sponsorRepayIndexerService',
}


it('handles SIGTERM and force-exits on a second signal during graceful shutdown', async t => {
  const { handlers, order, stopHooks, watchdogTimers, run } = fixture(t, services)
  const slow = Promise.withResolvers()
  stopHooks.set(services.RawEventsGatherer, async () => {
    order.push('stop entered')
    await slow.promise
    order.push('service stopped')
  })
  run([{ service: services.RawEventsGatherer }])
  await turn()
  assert.equal(typeof handlers.get('SIGTERM'), 'function')
  const first = handlers.get('SIGTERM')()
  try {
    await turn()
    assert.deepEqual(order, ['stop entered'])
    assert.deepEqual(watchdogTimers.map(x => x.ms), [10000])
    await handlers.get('SIGINT')()
    assert.deepEqual(order, ['stop entered', 'exit:1'])
  } finally {
    slow.resolve()
    await first
  }
})

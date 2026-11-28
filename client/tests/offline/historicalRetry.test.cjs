const { it } = require('node:test')
const { loadSource } = require('./loadSource.cjs')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')
const source = join(__dirname, '../../src/services/RawEventsGatherer/listenForRawEvents.ts')

function fixture({ failure = 'receipt', alwaysFail = false, controller } = {}) {
  const calls = { tx: 0, receipt: 0, waits: 0, stored: [], floor: 0, ticks: 0 }
  const log = { blockNumber: 7, transactionHash: 'fixture', index: 0, topics: [], address: 'mock' }
  class Interface {
    getEvent() { return { topicHash: 'mock' } }
    parseTransaction() { return { name: 'processActions', args: { packedActions: '0x01' } } }
  }
  const rpc = {
    getBlockNumber: async () => 7,
    getTransaction: async () => {
      calls.tx++
      if (failure === 'tx' && (alwaysFail || calls.tx === 1)) throw Error('mock tx RPC unavailable')
      return { data: '0x01' }
    },
    getTransactionReceipt: async () => {
      calls.receipt++
      if (failure === 'receipt' && (alwaysFail || calls.receipt === 1)) throw Error('mock receipt RPC unavailable')
      return { logs: [] }
    },
  }
  const mod = loadSource(source, {
    'node:timers/promises': { setTimeout: (ms, value, options) => {
      assert.equal(ms, 5000)
      calls.waits++
      if (!controller) return Promise.resolve()
      assert.equal(options.signal, controller.signal)
      const waiting = sleep(ms, value, options)
      controller.abort(Error('startup stopped'))
      return waiting
    } },
    ethers: {
      Interface,
      Contract: class { interface = new Interface() },
      toUtf8Bytes: s => Buffer.from(s), concat: chunks => Buffer.concat(chunks), keccak256: () => '0x01',
    },
    '../../abi/addresses': { CAW_ACTIONS_ADDRESS: 'mock' },
    '../../utils/rpcProvider': {
      getL2HttpRpcUrls: () => ['mock'], makeVerifiedFallbackJsonRpcProvider: async () => rpc,
    },
    '../../utils/chunkedLogs': { scanLogsForward: async () => [log] },
    '../../tools/delay': async () => { throw Error('unexpected historical scan retry') },
    smltxt: {},
    '../../utils/packActions': { unpackActions: () => [{ senderId: 1, cawonce: 2 }] },
    '../../utils/trace': { span: (_name, _attrs, work) => work() },
    '../../utils/indexerHealth': { recordIndexerProgress() {} },
  })
  const listen = mod.default
  return { calls, start: () => listen({
    rpcUrl: 'mock', contractAddress: 'mock', chainId: 1, networkId: 1, startBlock: 7,
    startupSignal: controller?.signal,
    onTick: () => { calls.ticks++ },
    rawEventsProvider: {
      getLastProcessedEvent: async () => null,
      isFloorFilled: async () => false,
      markFloorFilled: async () => { calls.floor++ },
      storeEvent: async e => { calls.stored.push(e.transactionHash) },
    },
  }) }
}

for (const failure of ['tx', 'receipt']) {
  it(`retries a transient historical ${failure} read and writes the event once`, async () => {
    const { calls, start } = fixture({ failure })
    const listener = await start()
    listener.stop()
    assert.equal(calls.waits, 1)
    assert.equal(calls[failure], 2)
    assert.deepEqual(calls.stored, ['fixture'])
    assert.equal(calls.floor, 1)
  })
}

it('does not mark history complete when the retry also fails', async () => {
  const { calls, start } = fixture({ alwaysFail: true })
  await assert.rejects(start(), /Could not fetch\/parse ActionRejected logs/)
  assert.equal(calls.receipt, 2)
  assert.equal(calls.floor, 0)
  assert.deepEqual(calls.stored, [])
})

{
  it('stops the historical retry delay with the exact startup cancellation reason', async () => {
    const controller = new AbortController()
    const { calls, start } = fixture({ controller })
    await assert.rejects(start(), error => error === controller.signal.reason)
    assert.equal(calls.receipt, 1)
    assert.equal(calls.waits, 1)
    assert.equal(calls.floor, 0)
    assert.deepEqual(calls.stored, [])
    assert.equal(calls.ticks, 0)
  })
}

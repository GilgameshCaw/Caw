/**
 * The peer cache only counts as complete once a cold scan has reached the
 * NetworkManager's deploy block without an RPC error. A scan that stops
 * early can leave a deactivated instance active in the cache, so the DM
 * relay's inbound checks wait for isPeerCacheComplete.
 *
 * refreshPeers keeps module-level state (cursor, deploy block, cache), so
 * every test starts and ends with _resetForTests().
 */

import { expect } from 'chai'
import { Interface } from 'ethers'
import { cawNetworkManagerAbi } from '../../src/abi/generated'
import {
  refreshPeers, getPeers, isPeerCacheComplete, _resetForTests,
} from '../../src/services/InstanceRegistryService'

const iface = new Interface(cawNetworkManagerAbi)
const MANAGER = '0x' + '11'.repeat(20)
const NETWORK_ID = 1
// IP literal so the apiUrl check needs no DNS.
const API_URL = 'https://93.184.216.34'
const key = (d: string) => '0x' + d.repeat(40)

function log(blockNumber: number, index: number, name: string, args: unknown[]) {
  const { data, topics } = iface.encodeEventLog(iface.getEvent(name)!, args)
  return { address: MANAGER, blockNumber, index, data, topics }
}

// Instance 2 registered at 2,000 and deactivated at 25,000; instance 7
// registered at 35,000. With the default 10,000-block chunk the backward
// walk from 40,000 covers 30,001–40,000, then 20,001–30,000, and so on.
const chain = [
  log(2_000, 0, 'InstanceRegistered', [2, NETWORK_ID, key('2'), API_URL, key('a')]),
  log(25_000, 0, 'InstanceDeactivated', [2]),
  log(35_000, 0, 'InstanceRegistered', [7, NETWORK_ID, key('7'), API_URL, key('b')]),
]

function makeProvider(opts: { head: number; failAt?: number; maxRange?: number; calls?: [number, number][] }) {
  return {
    async getBlockNumber() { return opts.head },
    async getCode(_addr: string, block: number) { return block >= 1_000 ? '0x60' : '0x' },
    async getLogs({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) {
      opts.calls?.push([fromBlock, toBlock])
      if (opts.maxRange !== undefined && toBlock - fromBlock + 1 > opts.maxRange) {
        throw new Error('range too large')
      }
      if (opts.failAt !== undefined && fromBlock <= opts.failAt && opts.failAt <= toBlock) {
        throw new Error('rate limited')
      }
      return chain
        .filter(l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock)
        .sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)
    },
  } as any
}

describe('InstanceRegistryService — complete scan', () => {
  beforeEach(() => _resetForTests())
  after(() => _resetForTests())

  it('is not complete before any scan', () => {
    expect(isPeerCacheComplete(NETWORK_ID)).to.equal(false)
  })

  it('stays incomplete after a cold scan that stopped on an RPC error', async () => {
    // Both tries at the 20,001–30,000 window fail, so the walk stops there.
    const result = await refreshPeers(makeProvider({ head: 40_000, failAt: 25_000 }), MANAGER, NETWORK_ID)
    expect(result.skipped).to.equal(true)
    expect(isPeerCacheComplete(NETWORK_ID)).to.equal(false)
    // The partial view: only instance 7 made it into the cache.
    expect(getPeers(NETWORK_ID).map(p => p.instanceId)).to.deep.equal([7])
  })

  it('becomes complete when the next cold scan reaches the deploy block', async () => {
    await refreshPeers(makeProvider({ head: 40_000, failAt: 25_000 }), MANAGER, NETWORK_ID)
    const result = await refreshPeers(makeProvider({ head: 40_000 }), MANAGER, NETWORK_ID)
    expect(result.skipped).to.equal(false)
    expect(isPeerCacheComplete(NETWORK_ID)).to.equal(true)
    const byId = new Map(getPeers(NETWORK_ID).map(p => [p.instanceId, p.active]))
    expect([...byId]).to.deep.equal([[2, false], [7, true]])
  })

  it('stays incomplete when a window only came back through its upper half', async () => {
    // A 6,000-block cap rejects every 10,000-block window and lets each upper
    // half through, so the walk reaches the deploy block without a failed
    // retry. The lower half of 1,000–10,000 (with instance 2's registration)
    // was never fetched.
    const result = await refreshPeers(makeProvider({ head: 40_000, maxRange: 6_000 }), MANAGER, NETWORK_ID)
    expect(result.skipped).to.equal(true)
    expect(isPeerCacheComplete(NETWORK_ID)).to.equal(false)
    expect(getPeers(NETWORK_ID).map(p => p.instanceId)).to.deep.equal([7])
  })

  it('scans cold again after a scan that forfeited a lower half', async () => {
    await refreshPeers(makeProvider({ head: 40_000, maxRange: 6_000 }), MANAGER, NETWORK_ID)
    const result = await refreshPeers(makeProvider({ head: 40_000 }), MANAGER, NETWORK_ID)
    expect(result.skipped).to.equal(false)
    expect(isPeerCacheComplete(NETWORK_ID)).to.equal(true)
    const byId = new Map(getPeers(NETWORK_ID).map(p => [p.instanceId, p.active]))
    expect([...byId]).to.deep.equal([[2, false], [7, true]])
  })

  it('caps the warm range at the chunk size and catches up one chunk per call', async () => {
    await refreshPeers(makeProvider({ head: 40_000 }), MANAGER, NETWORK_ID)
    const calls: [number, number][] = []
    const behind = makeProvider({ head: 65_000, calls })
    await refreshPeers(behind, MANAGER, NETWORK_ID)
    await refreshPeers(behind, MANAGER, NETWORK_ID)
    await refreshPeers(behind, MANAGER, NETWORK_ID)
    await refreshPeers(behind, MANAGER, NETWORK_ID)
    expect(calls).to.deep.equal([[40_001, 50_000], [50_001, 60_000], [60_001, 65_000]])
    expect(isPeerCacheComplete(NETWORK_ID)).to.equal(true)
  })
})

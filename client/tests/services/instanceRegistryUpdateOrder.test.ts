/**
 * The cold scan walks backward, so an instance's InstanceUpdated events from
 * different scan windows reach refreshPeers newest first. They must still be
 * applied oldest → newest, or the cache keeps the older apiUrl /
 * validatorAddress.
 *
 * refreshPeers keeps a module-level cursor, so only the first call in a
 * process takes the cold path. This file makes exactly one such call.
 */

import { expect } from 'chai'
import { Interface } from 'ethers'
import { cawNetworkManagerAbi } from '../../src/abi/generated'
import { refreshPeers, getPeers, inChainOrder } from '../../src/services/InstanceRegistryService'

const iface = new Interface(cawNetworkManagerAbi)
const MANAGER = '0x' + '11'.repeat(20)
const NETWORK_ID = 1
const INSTANCE_ID = 5
// IP literal so the apiUrl check needs no DNS.
const API_URL = 'https://93.184.216.34'
const key = (d: string) => '0x' + d.repeat(40)

function log(blockNumber: number, index: number, name: string, args: unknown[]) {
  const { data, topics } = iface.encodeEventLog(iface.getEvent(name)!, args)
  return { address: MANAGER, blockNumber, index, data, topics }
}

describe('InstanceRegistryService — InstanceUpdated order', () => {
  it('inChainOrder sorts by block, then log index', () => {
    const logs = [
      { blockNumber: 31_000, index: 0 },
      { blockNumber: 12_000, index: 4 },
      { blockNumber: 12_000, index: 1 },
    ]
    expect(inChainOrder(logs)).to.deep.equal([
      { blockNumber: 12_000, index: 1 },
      { blockNumber: 12_000, index: 4 },
      { blockNumber: 31_000, index: 0 },
    ])
    expect(logs[0].blockNumber).to.equal(31_000) // input left as is
  })

  it('a cold scan keeps the latest update when updates sit in different scan windows', async () => {
    // Registered at 2,000 with key 0, updated at 12,000 (key 1) and at
    // 31,000 (key 3). With the default 10,000-block chunk the two updates
    // land in different windows of the backward walk.
    const chain = [
      log(2_000, 0, 'InstanceRegistered', [INSTANCE_ID, NETWORK_ID, key('2'), API_URL, key('0')]),
      log(12_000, 0, 'InstanceUpdated', [INSTANCE_ID, API_URL, key('1')]),
      log(31_000, 0, 'InstanceUpdated', [INSTANCE_ID, API_URL, key('3')]),
    ]
    const provider: any = {
      async getBlockNumber() { return 40_000 },
      async getCode(_addr: string, block: number) { return block >= 1_000 ? '0x60' : '0x' },
      // Like a real node: ascending within the requested range.
      async getLogs({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) {
        return chain
          .filter(l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock)
          .sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)
      },
    }

    const result = await refreshPeers(provider, MANAGER, NETWORK_ID)
    expect(result.skipped).to.equal(false)

    const peer = getPeers(NETWORK_ID).find(p => p.instanceId === INSTANCE_ID)
    expect(peer?.validatorAddress.toLowerCase()).to.equal(key('3'))
  })
})

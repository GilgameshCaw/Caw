import { expect, it } from 'vitest'
import { createPublicClient, custom, encodeAbiParameters, encodeEventTopics, getFunctionSelector, toHex } from 'viem'
import { cawNetworkManagerAbi as abi } from '../../../../abi/generated'
import { readRegistryInstances } from './readRegistryInstances'

const address = '0x0000000000000000000000000000000000000011'
const hash = toHex(101, { size: 32 })
const head = 340_111
function log(id: number, height: number, index: number, apiUrl: string, network?: number) {
  const topics = network === undefined
    ? encodeEventTopics({ abi, eventName: 'InstanceUpdated', args: { instanceId: id } })
    : encodeEventTopics({ abi, eventName: 'InstanceRegistered',
        args: { instanceId: id, networkId: network, owner: address } })
  return { address, blockNumber: toHex(height), blockHash: hash, logIndex: toHex(index),
    transactionIndex: '0x0', transactionHash: hash, removed: false, topics,
    data: encodeAbiParameters([{ type: 'string' }, { type: 'address' }], [apiUrl, address]) }
}
const history = [
  log(1, 2, 0, 'first', 1), log(2, 500, 0, 'other network', 2),
  log(1, 330_115, 1, 'older update'), log(3, head - 1, 0, 'recent', 1),
  log(1, head, 3, 'latest update'), log(1, head, 1, 'earlier in same block'),
]
function provider({ logs = history, limit = 10_000, missingBlock = -1,
    failActive = false, replaceHead = false, next = 4 } = {}) {
  const ranges: number[][] = []
  return { ranges, client: createPublicClient({ cacheTime: 0, transport: custom({
    async request({ method, params }: {method: string; params: any[]}) {
      if (method === 'eth_getBlockByNumber') {
        const replaced = replaceHead && params[0] !== 'latest'
        return { number: toHex(head), hash: replaced ? toHex(102, {size:32}) : hash, transactions: [] }
      }
      if (method === 'eth_call') {
        expect(params[1]).toBe(toHex(head))
        if (params[0].data === getFunctionSelector('nextInstanceId()')) return toHex(next, {size:32})
        if (failActive) throw Error('active state unavailable')
        const id = Number(BigInt('0x' + params[0].data.slice(10)))
        return toHex(id === 1 ? 0 : 1, {size:32})
      }
      if (method === 'eth_getLogs') {
        const { fromBlock, toBlock, topics } = params[0]
        const from = Number(BigInt(fromBlock)), to = Number(BigInt(toBlock))
        if (to - from + 1 > limit || (from <= missingBlock && missingBlock <= to)) throw Error('range unavailable')
        ranges.push([from, to])
        return logs.filter(e => Number(BigInt(e.blockNumber)) >= from &&
          Number(BigInt(e.blockNumber)) <= to && topics[0].includes(e.topics[0]))
      }
      throw Error('unexpected method ' + method)
    },
  }, { retryCount: 0 }) }) }
}

it.each([10_000, 3_000])('recovers sparse registrations and latest updates with a %i block provider limit', async limit => {
  const {client, ranges} = provider({limit})
  const peers = await readRegistryInstances(client, address, 1)
  expect(peers.map(p => [p.instanceId, p.apiUrl, p.active])).toEqual([
    [3, 'recent', true], [1, 'latest update', false],
  ])
  expect(ranges[0][1]).toBe(head)
  for (let i = 1; i < ranges.length; i++) expect(ranges[i][1]).toBe(ranges[i - 1][0] - 1)
})
it('rejects a missing registration at genesis', async () => {
  await expect(readRegistryInstances(provider({logs:history.slice(1)}).client,address,1)).rejects.toThrow(/incomplete/)
})
it('rejects a provider gap instead of returning partial peers', async () => {
  await expect(readRegistryInstances(provider({missingBlock:head-10}).client,address,1)).rejects.toThrow()
})
it('does not mark an unreadable active flag true', async () => {
  await expect(readRegistryInstances(provider({failActive:true}).client,address,1)).rejects.toThrow()
})
it('rejects a replaced checkpoint', async () => {
  await expect(readRegistryInstances(provider({replaceHead:true}).client,address,1)).rejects.toThrow(/checkpoint changed/)
})
it('accepts a confirmed empty registry without scanning', async () => {
  const {client,ranges} = provider({next:1})
  expect(await readRegistryInstances(client,address,1)).toEqual([])
  expect(ranges).toEqual([])
})

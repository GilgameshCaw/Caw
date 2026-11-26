import { getAbiItem, type Address, type Client } from 'viem'
import { getBlock, getLogs, readContract } from 'viem/actions'
import { cawNetworkManagerAbi } from '../../../../abi/generated'

const abi = cawNetworkManagerAbi
const events = [
  getAbiItem({ abi, name: 'InstanceRegistered' }),
  getAbiItem({ abi, name: 'InstanceUpdated' }),
] as const

export async function readRegistryInstances(client: Client, address: Address, networkId: number) {
  const head = await getBlock(client, { blockTag: 'latest', includeTransactions: false })
  const at = { abi, address, blockNumber: head.number } as const
  const next = await readContract(client, { ...at, functionName: 'nextInstanceId' })
  if (next < 1) throw new Error('Registry counter unavailable')

  // IDs are allocated globally from one and never recycled. All registrations,
  // including other networks, are needed to know when the backward walk is done.
  const registered = new Set<number>()
  const latestUpdate = new Map<number, { apiUrl: string; validatorAddress: Address }>()
  const instances = []
  let last = head.number
  const maxWidth = 10_000n
  let width = maxWidth
  let successfulPages = 0
  while (registered.size < next - 1) {
    const first = last >= width ? last - width + 1n : 0n
    const query = () => getLogs(client, { address, events, fromBlock: first, toBlock: last, strict: true })
    let logs: Awaited<ReturnType<typeof query>>
    try {
      logs = await query()
    } catch (error) {
      if (first === last) throw error
      successfulPages = 0
      width = (last - first + 1n) / 2n
      continue // Keep the same upper bound until every block in the range was read.
    }
    logs.sort((a, b) => a.blockNumber === b.blockNumber
      ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1)
    for (const log of logs) {
      const id = log.args.instanceId
      if (id < 1 || id >= next || log.removed || log.blockNumber < first || log.blockNumber > last ||
          log.address.toLowerCase() !== address.toLowerCase()) throw new Error('Inconsistent registry log')
      if (log.eventName === 'InstanceUpdated') {
        if (!latestUpdate.has(id)) latestUpdate.set(id, log.args)
      } else {
        if (registered.has(id)) throw new Error('Duplicate registry registration')
        registered.add(id)
        if (log.args.networkId === networkId) {
          const endpoint = latestUpdate.get(id) ?? log.args
          instances.push({ instanceId: id, networkId, owner: log.args.owner,
            apiUrl: endpoint.apiUrl, validatorAddress: endpoint.validatorAddress })
        }
      }
    }
    if (first === 0n) break
    last = first - 1n
    // A dense window may require tiny pages. Recover the usual page size in sparse history.
    if (width < maxWidth && ++successfulPages === 8) {
      width = width * 2n > maxWidth ? maxWidth : width * 2n
      successfulPages = 0
    }
  }
  if (registered.size !== next - 1) throw new Error('Registration history is incomplete')
  const result = []
  for (const instance of instances) {
    const active = await readContract(client, { ...at, functionName: 'instanceActive', args: [instance.instanceId] })
    result.push({ ...instance, active })
  }
  if ((await getBlock(client, { blockNumber: head.number })).hash !== head.hash) {
    throw new Error('Registry checkpoint changed')
  }
  return result
}

// One-shot: list all InstanceRegistered events for a given clientId by
// scanning chain history directly. Lets us cross-check a node's local
// /api/instances cache against what's actually on chain.
//
// Usage:
//   cd client
//   npx tsx scripts/list-instances.ts [clientId]

import 'dotenv/config'
import { Contract } from 'ethers'
import { makeJsonRpcProvider, getL1HttpRpcUrl } from '../src/utils/rpcProvider'
import { scanLogsBackward } from '../src/utils/chunkedLogs'

const CLIENT_MANAGER = '0xA5C515D35C291110090b6edc4278acdEf1424C7a' // testnet L1

const ABI = [
  'event InstanceRegistered(uint32 indexed instanceId, uint32 indexed networkId, address indexed owner, string apiUrl, address validatorAddress)',
  'event InstanceUpdated(uint32 indexed instanceId, string apiUrl, address validatorAddress)',
  'event InstanceDeactivated(uint32 indexed instanceId)',
]

async function main() {
  const clientId = Number(process.argv[2] || 1)
  const provider = makeJsonRpcProvider(getL1HttpRpcUrl())
  const cm = new Contract(CLIENT_MANAGER, ABI, provider)

  const iface = cm.interface
  const regTopic = iface.getEvent('InstanceRegistered')!.topicHash
  const updTopic = iface.getEvent('InstanceUpdated')!.topicHash
  const deacTopic = iface.getEvent('InstanceDeactivated')!.topicHash
  const clientIdTopic = '0x' + clientId.toString(16).padStart(64, '0')

  console.log(`Scanning backward from latest for clientId=${clientId}...`)

  // Single backward scan covering all three event types, then split.
  const allTopics = [regTopic, updTopic, deacTopic]
  const all = await scanLogsBackward(provider, CLIENT_MANAGER, [allTopics])
  const clientIdTopicLc = clientIdTopic.toLowerCase()
  const regLogs = all.filter(l => l.topics[0] === regTopic && (l.topics[2] || '').toLowerCase() === clientIdTopicLc)
  const updLogs = all.filter(l => l.topics[0] === updTopic)
  const deacLogs = all.filter(l => l.topics[0] === deacTopic)
  console.log(`  ${all.length} total events found (${regLogs.length} reg / ${updLogs.length} upd / ${deacLogs.length} deact for any clientId)`)

  const instances = new Map<number, { apiUrl: string; validatorAddress: string; owner: string; active: boolean; registeredBlock: number; lastBlock: number }>()

  for (const log of regLogs) {
    const parsed = iface.parseLog(log)!
    const instanceId = Number(parsed.args.instanceId)
    instances.set(instanceId, {
      apiUrl: parsed.args.apiUrl,
      validatorAddress: parsed.args.validatorAddress,
      owner: parsed.args.owner,
      active: true,
      registeredBlock: log.blockNumber,
      lastBlock: log.blockNumber,
    })
  }
  for (const log of updLogs) {
    const parsed = iface.parseLog(log)!
    const instanceId = Number(parsed.args.instanceId)
    const inst = instances.get(instanceId)
    if (inst) {
      inst.apiUrl = parsed.args.apiUrl
      inst.validatorAddress = parsed.args.validatorAddress
      inst.lastBlock = log.blockNumber
    }
  }
  for (const log of deacLogs) {
    const parsed = iface.parseLog(log)!
    const instanceId = Number(parsed.args.instanceId)
    const inst = instances.get(instanceId)
    if (inst) {
      inst.active = false
      inst.lastBlock = log.blockNumber
    }
  }

  console.log(`\nFound ${instances.size} instance(s) for clientId=${clientId}:\n`)
  for (const [id, inst] of [...instances.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  #${id}  ${inst.active ? '✓ active  ' : '✗ inactive'}  ${inst.apiUrl}`)
    console.log(`        owner=${inst.owner}  validator=${inst.validatorAddress}`)
    console.log(`        registered@${inst.registeredBlock}  last@${inst.lastBlock}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })

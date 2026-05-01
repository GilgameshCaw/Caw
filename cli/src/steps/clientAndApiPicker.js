// Frontend-only "External API URL" picker that pulls live state from the
// L1 CawClientManager contract:
//
//   1. Read every Client (id, name) directly via getClient(id) for
//      id in [1..nextClientId-1] — no event scan needed.
//   2. For the chosen clientId, scan InstanceRegistered + InstanceUpdated
//      events filtered to that client. apiUrl lives in events (the
//      contract intentionally doesn't store strings on-chain to save gas),
//      so an event scan is the only path here.
//   3. Present each registered apiUrl as a list choice + an "Other (type
//      your own)" fallback for ops scenarios (private dev API, a node
//      that hasn't broadcast yet, etc).
//
// Read-only — no validator key needed, no fees paid. Falls back gracefully
// to a free-text prompt if the L1 RPC is unreachable, the client list is
// empty, or anything else goes sideways. The fallback is what we did
// before this step existed, so the worst case is "the new step adds zero
// friction."

import inquirer from 'inquirer'
import { Contract, JsonRpcProvider } from 'ethers'
import { brand, dim, section, tipBlock, warn } from '../utils/ui.js'
import { addr } from '../addresses.js'

// Minimal ABI — just what we need. Saves importing the full generated.ts
// (the CLI doesn't currently import any client-side ABIs and starting
// would add a real coupling).
const CLIENT_MANAGER_ABI = [
  'function nextClientId() view returns (uint32)',
  'function nextInstanceId() view returns (uint32)',
  'function getClient(uint32 clientId) view returns (tuple(uint32 id, uint32 storageChainEid, string name, address ownerAddress, address feeAddress, uint256 mintFee, uint256 authFee, uint256 depositFee, uint256 withdrawFee))',
  'function instanceActive(uint32) view returns (bool)',
  'event InstanceRegistered(uint32 indexed instanceId, uint32 indexed clientId, address indexed owner, string apiUrl, address validatorAddress)',
  'event InstanceUpdated(uint32 indexed instanceId, string apiUrl, address validatorAddress)',
]

// Public read-only Sepolia RPCs. Tried in order; first that responds wins.
// Picked because they're the two with the most generous unauthed throughput
// — a fresh-install operator hasn't configured Infura yet, so we can't
// rely on their personal key.
const PUBLIC_SEPOLIA_RPCS = [
  'https://ethereum-sepolia.publicnode.com',
  'https://rpc.sepolia.org',
]

/**
 * Try each RPC in order with a short per-attempt timeout. Returns the
 * first provider that successfully reports a block number, or null if
 * all of them fail. We don't want a slow public RPC to stall the install.
 */
async function pickWorkingRpc(urls, perAttemptTimeoutMs = 4000) {
  for (const url of urls) {
    try {
      const provider = new JsonRpcProvider(url, undefined, { staticNetwork: true })
      // getBlockNumber is the lightest sanity check — also wakes up the
      // provider so the chain-id / network fetch lands before our first
      // real read.
      const result = await Promise.race([
        provider.getBlockNumber(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), perAttemptTimeoutMs)),
      ])
      if (typeof result === 'number') return provider
    } catch {
      // try the next one
    }
  }
  return null
}

/**
 * Pull the client roster directly from on-chain state.
 * Returns [{ id, name, ownerAddress }, …] sorted by id.
 */
async function loadClients(provider, clientManagerAddress) {
  const cm = new Contract(clientManagerAddress, CLIENT_MANAGER_ABI, provider)
  const nextId = Number(await cm.nextClientId())
  if (nextId <= 1) return [] // no clients exist

  const clients = []
  // Sequential reads so we don't blow up a public RPC's per-IP rate limit.
  // nextClientId is realistically <50 today; this is fine.
  for (let id = 1; id < nextId; id++) {
    try {
      const c = await cm.getClient(id)
      // Client structs with ownerAddress=0x0 are deleted/never-existed
      // (defensive — current contract doesn't actually delete them).
      if (c.ownerAddress && c.ownerAddress !== '0x0000000000000000000000000000000000000000') {
        clients.push({ id, name: c.name, ownerAddress: c.ownerAddress })
      }
    } catch { /* skip individual failures, keep going */ }
  }
  return clients
}

/**
 * Walk backwards from `latest` in CHUNK-sized windows pulling matching
 * logs. Public RPCs commonly reject `fromBlock=0` (or any range >50K
 * blocks) for getLogs, so we have to chunk. We stop as soon as we hit
 * the first window with no logs AFTER finding at least one — registration
 * events are clustered around the contract's deployment + recent
 * onboardings, never spread evenly across history.
 *
 * Returns the unfiltered raw logs (caller decodes).
 */
async function chunkedQueryLogs(provider, addr, topics, opts = {}) {
  const CHUNK = opts.chunk || 50000
  const MAX_WINDOWS = opts.maxWindows || 20 // ~1M blocks back
  const latest = await provider.getBlockNumber()
  let toBlock = latest
  const logs = []
  let foundAny = false
  for (let i = 0; i < MAX_WINDOWS; i++) {
    const fromBlock = Math.max(0, toBlock - CHUNK)
    let got
    try {
      got = await provider.getLogs({ address: addr, topics, fromBlock, toBlock })
    } catch {
      // Probably the public RPC's range limit; halve and retry once before
      // giving up on this window.
      try {
        const half = Math.floor((toBlock - fromBlock) / 2)
        got = await provider.getLogs({ address: addr, topics, fromBlock: toBlock - half, toBlock })
        // Don't push the lower half — better to miss than hang the install.
      } catch {
        break
      }
    }
    if (got.length > 0) foundAny = true
    logs.push(...got)
    // If we've found events and the current window is empty, history's
    // probably done — bail rather than scanning to genesis.
    if (foundAny && got.length === 0) break
    if (fromBlock === 0) break
    toBlock = fromBlock - 1
  }
  return logs
}

/**
 * Pull all registered instances for a given clientId by scanning events
 * (apiUrl isn't in contract storage). Applies InstanceUpdated overrides
 * so each instanceId maps to its CURRENT apiUrl, then filters out
 * deactivated instances via the on-chain instanceActive() flag.
 */
async function loadInstances(provider, clientManagerAddress, clientId) {
  const cm = new Contract(clientManagerAddress, CLIENT_MANAGER_ABI, provider)
  const iface = cm.interface

  // Topic-filter on (sig, indexed instanceId=ANY, indexed clientId).
  // ethers' filters.InstanceRegistered(null, clientId) builds the right
  // shape, but we need the topics directly for getLogs.
  const regSigTopic = iface.getEvent('InstanceRegistered').topicHash
  const clientIdTopic = '0x' + clientId.toString(16).padStart(64, '0')
  const regLogs = await chunkedQueryLogs(provider, clientManagerAddress, [
    regSigTopic, null, clientIdTopic,
  ])

  const byInstanceId = new Map()
  for (const log of regLogs) {
    const parsed = iface.parseLog(log)
    if (!parsed) continue
    const a = parsed.args
    byInstanceId.set(Number(a.instanceId), {
      instanceId: Number(a.instanceId),
      apiUrl: a.apiUrl,
      validatorAddress: a.validatorAddress,
      owner: a.owner,
    })
  }

  // Apply InstanceUpdated to refresh apiUrl / validatorAddress. The
  // updated event is NOT clientId-indexed — pull all and filter by
  // instanceId membership.
  if (byInstanceId.size > 0) {
    const updSigTopic = iface.getEvent('InstanceUpdated').topicHash
    const updLogs = await chunkedQueryLogs(provider, clientManagerAddress, [updSigTopic])
    for (const log of updLogs) {
      const parsed = iface.parseLog(log)
      if (!parsed) continue
      const a = parsed.args
      const cur = byInstanceId.get(Number(a.instanceId))
      if (cur) {
        cur.apiUrl = a.apiUrl
        cur.validatorAddress = a.validatorAddress
      }
    }
  }

  // Drop deactivated instances. Single batched check per instance —
  // small list (<100 typical), and we're already on a slow public RPC.
  const result = []
  for (const inst of byInstanceId.values()) {
    try {
      const active = await cm.instanceActive(inst.instanceId)
      if (active) result.push(inst)
    } catch {
      // If we can't tell, include it — better to surface a possibly-dead
      // instance than to silently hide a live one.
      result.push(inst)
    }
  }
  return result.sort((a, b) => a.instanceId - b.instanceId)
}

/**
 * Run the full picker flow. Returns the chosen apiUrl as a string
 * (with scheme), or null if the operator backed out / state was empty
 * and they declined to type one. Caller is expected to fall back to
 * its own free-text prompt on null.
 */
export async function pickClientAndApi({ network }) {
  // Mainnet has its own ClientManager address but we haven't shipped
  // mainnet yet. The addresses.js loader will return whatever is in
  // deployments.ts for the chosen network.
  if (network && network !== 'testnet') {
    // Future-proof: if the addresses lookup yields a mainnet address,
    // pickWorkingRpc would need a mainnet URL. Until then, bail out
    // and let the caller fall back to free-text.
    return null
  }

  let clientManagerAddress
  try { clientManagerAddress = addr('CLIENT_MANAGER_ADDRESS') } catch { return null }
  if (!clientManagerAddress) return null

  section('Looking up registered clients on-chain')
  console.log(dim(`  Reading ${brand('CawClientManager')} at ${clientManagerAddress}...`))

  const provider = await pickWorkingRpc(PUBLIC_SEPOLIA_RPCS)
  if (!provider) {
    console.log(warn('  Couldn\'t reach any public Sepolia RPC — skipping the on-chain picker.'))
    return null
  }

  let clients
  try {
    clients = await loadClients(provider, clientManagerAddress)
  } catch (err) {
    console.log(warn(`  Failed to load client list: ${err.message} — skipping.`))
    return null
  }

  if (clients.length === 0) {
    console.log(warn('  No clients registered yet — falling back to manual entry.'))
    return null
  }

  // Pick a client.
  const { clientId } = await inquirer.prompt([{
    type: 'list',
    name: 'clientId',
    message: 'Which client will this frontend serve?',
    choices: [
      ...clients.map(c => ({
        value: c.id,
        name: `${brand('#' + c.id)}  ${c.name || dim('(unnamed)')}  ${dim('owner: ' + c.ownerAddress.slice(0, 10) + '…')}`,
      })),
      new inquirer.Separator(),
      { value: '__custom__', name: dim('Other — type a URL manually') },
    ],
    pageSize: 12,
  }])

  if (clientId === '__custom__') return null

  // Pick an instance (or back out to manual).
  let instances
  try {
    instances = await loadInstances(provider, clientManagerAddress, clientId)
  } catch (err) {
    console.log(warn(`  Failed to load instance list: ${err.message}`))
    return null
  }

  if (instances.length === 0) {
    tipBlock([
      `Client ${brand('#' + clientId)} has no broadcast nodes yet.`,
      'You can still serve this client by pointing at a private API URL.',
    ])
    return null
  }

  const { apiUrl } = await inquirer.prompt([{
    type: 'list',
    name: 'apiUrl',
    message: 'Pick an API to point this frontend at:',
    choices: [
      ...instances.map(i => ({
        value: i.apiUrl,
        name: `${i.apiUrl}  ${dim('instance #' + i.instanceId + ', validator: ' + i.validatorAddress.slice(0, 10) + '…')}`,
      })),
      new inquirer.Separator(),
      { value: '__custom__', name: dim('Other — type a URL manually') },
    ],
    pageSize: 10,
  }])

  if (apiUrl === '__custom__') return null
  return apiUrl
}

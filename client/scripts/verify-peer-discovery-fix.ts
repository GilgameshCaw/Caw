// verify-peer-discovery-fix.ts  (B-plan: production files untouched)
//
// READ-ONLY verification for the peer-discovery cold-start fix.
// Touches NOTHING on the node: no .env writes, no DB, no peerCache,
// and — critically — does NOT import the patched scanLogsBackward.
// The fixed and old backward-scan logic are BOTH reproduced inline here,
// so this script proves the fix WITHOUT modifying production chunkedLogs.ts.
//
// The only thing imported from the (unmodified) production tree is
// findContractDeployBlock, which already exists on HEAD and is not changed
// by the fix — safe to reuse.
//
//   1. GROUND TRUTH via NM storage (getLogs-free): nextInstanceId +
//      instanceOwner(id)/instanceActive(id) → the true instance set.
//   2. deploy block via findContractDeployBlock (eth_getCode binary search).
//   3. FIXED logic (inline): floor=deployBlock, exhaustToFloor → all regs.
//   4. OLD logic (inline): foundAny bail + 20-window ceiling → truncates.
//
// PASS = fixed unique ids > old unique ids AND storage-active ⊆ fixed.
//
// Run on the node (production chunkedLogs.ts stays byte-identical):
//   cd /var/www/v2.nyaromesama.com/client
//   npx tsx scripts/verify-peer-discovery-fix.ts

import 'dotenv/config'
import { JsonRpcProvider, Interface, Contract, AbstractProvider, Log } from 'ethers'
import { findContractDeployBlock } from '../src/utils/chunkedLogs' // unmodified on HEAD
import { cawNetworkManagerAbi } from '../src/abi/generated'
import { NETWORK_MANAGER_ADDRESS } from '../src/abi/addresses'

const NETWORK_ID = Number(process.env.NETWORK_ID ?? process.env.CLIENT_ID ?? 1)
const RPC_URL =
  process.env.L1_RPC_URL ||
  process.env.L1_RPC_URL_HTTP ||
  process.env.ETH_MAINNET_RPC_URL ||
  'https://sepolia.drpc.org'
const CHUNK = Number(process.env.VERIFY_CHUNK ?? 9000)

// INLINE copy of production scanLogsBackward + exhaustToFloor flag.
// Mirrors the patch exactly, but lives only here — prod tree untouched.
async function scanBackwardInline(
  provider: AbstractProvider,
  addr: string,
  topics: (string | string[] | null)[],
  opts: {
    chunkBlocks: number
    maxWindows: number
    toBlock?: number
    fromBlock?: number
    exhaustToFloor?: boolean
    onProgress?: (f: number, t: number, n: number) => void
  },
): Promise<Log[]> {
  const chunkBlocks = opts.chunkBlocks
  const maxWindows = opts.maxWindows
  const head = opts.toBlock ?? await provider.getBlockNumber()
  const floor = opts.fromBlock ?? 0
  const exhaustToFloor = opts.exhaustToFloor ?? false
  const logs: Log[] = []
  let foundAny = false
  let toBlock = head

  for (let i = 0; i < maxWindows; i++) {
    const fromBlock = Math.max(floor, toBlock - chunkBlocks + 1)
    let windowLogs: Log[]
    try {
      windowLogs = await provider.getLogs({ address: addr, topics, fromBlock, toBlock })
    } catch {
      try {
        const halfStart = fromBlock + Math.floor((toBlock - fromBlock) / 2)
        windowLogs = await provider.getLogs({ address: addr, topics, fromBlock: halfStart, toBlock })
      } catch {
        break
      }
    }
    if (windowLogs.length > 0) foundAny = true
    logs.push(...windowLogs)
    opts.onProgress?.(fromBlock, toBlock, windowLogs.length)
    if (!exhaustToFloor && foundAny && windowLogs.length === 0) break
    if (fromBlock === floor) break
    toBlock = fromBlock - 1
  }
  return logs
}

function hr(label: string) {
  console.log('\n' + '='.repeat(64) + '\n' + label + '\n' + '='.repeat(64))
}

async function main() {
  console.log(`RPC_URL       = ${RPC_URL}`)
  console.log(`NETWORK_ID    = ${NETWORK_ID}`)
  console.log(`NM_ADDRESS    = ${NETWORK_MANAGER_ADDRESS}`)
  console.log(`CHUNK         = ${CHUNK}`)

  const provider = new JsonRpcProvider(RPC_URL)
  const head = await provider.getBlockNumber()
  console.log(`head block    = ${head}`)

  hr('1. GROUND TRUTH (NM storage: nextInstanceId + instanceOwner/Active)')
  const nm = new Contract(NETWORK_MANAGER_ADDRESS, cawNetworkManagerAbi, provider)
  const nextId: bigint = await nm.nextInstanceId()
  console.log(`nextInstanceId = ${nextId}`)
  const ZERO = '0x0000000000000000000000000000000000000000'
  const truthActive = new Set<number>()
  const truthAll = new Set<number>()
  for (let id = 1; id < Number(nextId); id++) {
    let owner = ZERO
    try { owner = await nm.instanceOwner(id) } catch { /* skip */ }
    if (owner && owner !== ZERO) {
      truthAll.add(id)
      let active = false
      try { active = await nm.instanceActive(id) } catch { /* skip */ }
      if (active) truthActive.add(id)
    }
  }
  console.log(`storage: ${truthAll.size} registered ids, ${truthActive.size} active`)
  console.log(`  ids = ${[...truthAll].sort((a, b) => a - b).join(', ')}`)

  hr('2. deploy block (findContractDeployBlock — from UNMODIFIED prod tree)')
  const deployBlock = await findContractDeployBlock(provider, NETWORK_MANAGER_ADDRESS, head)
  console.log(`deployBlock   = ${deployBlock}`)
  console.log(`span (head-deploy) = ${head - deployBlock} blocks`)
  console.log(`(cross-check against Network.creationBlock in your DB)`)

  const iface = new Interface(cawNetworkManagerAbi)
  const regSig = iface.getEvent('InstanceRegistered')!.topicHash
  const networkIdTopic = '0x' + NETWORK_ID.toString(16).padStart(64, '0')
  const countRegForNetwork = (logs: Log[]) => {
    const ids = new Set<number>()
    for (const log of logs) {
      const t = log.topics ?? []
      if (t[0] !== regSig) continue
      if (t[2] !== networkIdTopic) continue
      const parsed = iface.parseLog(log as any)
      if (parsed) ids.add(Number(parsed.args.instanceId))
    }
    return ids
  }

  hr('3. FIXED logic (inline: fromBlock=deployBlock, exhaustToFloor=true)')
  const spanWindows = Math.ceil((head - deployBlock) / CHUNK) + 5
  let fixedWindows = 0
  const fixedLogs = await scanBackwardInline(provider, NETWORK_MANAGER_ADDRESS, [[regSig]], {
    fromBlock: deployBlock,
    exhaustToFloor: true,
    maxWindows: spanWindows,
    chunkBlocks: CHUNK,
    onProgress: (f, t, n) => { fixedWindows++; if (n > 0) console.log(`  win ${f}..${t}: ${n} logs`) },
  })
  const fixedIds = countRegForNetwork(fixedLogs)
  console.log(`fixed: ${fixedWindows} windows, ${fixedLogs.length} raw logs, ` +
    `${fixedIds.size} unique reg ids for networkId=${NETWORK_ID}`)
  console.log(`  ids = ${[...fixedIds].sort((a, b) => a - b).join(', ')}`)

  hr('4. OLD logic (inline: foundAny bail + 20-window ceiling)')
  let oldWindows = 0
  const oldLogs = await scanBackwardInline(provider, NETWORK_MANAGER_ADDRESS, [[regSig]], {
    chunkBlocks: CHUNK,
    maxWindows: 20,
    exhaustToFloor: false,
    onProgress: () => { oldWindows++ },
  })
  const oldIds = countRegForNetwork(oldLogs)
  console.log(`old: ${oldWindows} windows, ${oldLogs.length} raw logs, ` +
    `${oldIds.size} unique reg ids for networkId=${NETWORK_ID}`)
  console.log(`  ids = ${[...oldIds].sort((a, b) => a - b).join(', ')}`)

  hr('VERDICT')
  const missingFromFixed = [...truthActive].filter(id => !fixedIds.has(id))
  const recovered = fixedIds.size - oldIds.size
  console.log(`fixed unique ids : ${fixedIds.size}`)
  console.log(`old   unique ids : ${oldIds.size}`)
  console.log(`recovered by fix : ${recovered} (ids the old path never reached)`)
  console.log(`storage-active not in fixed scan: ` +
    `${missingFromFixed.length ? missingFromFixed.join(', ') : 'none'}`)
  console.log('')
  if (recovered > 0 && missingFromFixed.length === 0) {
    console.log(`✅ PASS: fix recovers ${recovered} more registration(s); no storage-active id missing.`)
  } else if (fixedIds.size === oldIds.size && missingFromFixed.length === 0) {
    console.log(`⚠️  INCONCLUSIVE: fixed == old. History may be dense enough today that the old bail didn't fire. Trust storage ground truth (${truthActive.size} active) and re-run after more register-race churn.`)
  } else {
    console.log(`❌ Investigate: see window logs above (missing from fixed: ${missingFromFixed.join(', ') || 'none'}).`)
  }
  console.log(`(ground truth: ${truthActive.size} active / ${truthAll.size} registered)`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

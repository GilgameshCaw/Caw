// Verify the ActionsProcessed scan in reconstructCheckpointData against live
// RPCs: the same block range must yield the same logs whatever the chunk
// size, and a capped RPC must work: the walk starts at 50,000 blocks and
// shrinks the window with the real walkLogsBackward(), retrying the same range.
// Read-only.
// Usage: npx tsx scripts/verify-replication-log-chunk.ts <referenceRpcUrl> [cappedRpcUrl] [networkId] [fromBlock]
// Without fromBlock the range is the latest 50,000 blocks, which can hold no logs;
// pass a fromBlock whose 50,000 blocks do, or the comparison proves nothing.
import { JsonRpcProvider, Contract } from 'ethers'
import { cawActionsAbi } from '../src/abi/generated'
import { walkLogsBackward } from '../src/utils/walkLogsBackward'
import { CAW_ACTIONS_ADDRESS, CAW_ACTIONS_ERC1271_ADDRESS } from '../src/abi/addresses'

const [REF, CAPPED = 'https://sepolia.base.org', NET = '1', FROM_ARG] = process.argv.slice(2)
if (!REF) {
  console.error('usage: npx tsx scripts/verify-replication-log-chunk.ts <referenceRpcUrl> [cappedRpcUrl] [networkId] [fromBlock]')
  process.exit(1)
}
const networkId = Number(NET)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Same backward walk as reconstructCheckpointData, over a fixed range.
async function scan(rpc: string, chunk: number, from: number, to: number, delayMs = 0) {
  const provider = new JsonRpcProvider(rpc)
  const contracts = [new Contract(CAW_ACTIONS_ADDRESS, cawActionsAbi as any, provider)]
  if (CAW_ACTIONS_ERC1271_ADDRESS) contracts.push(new Contract(CAW_ACTIONS_ERC1271_ADDRESS, cawActionsAbi as any, provider))
  const keys: string[] = []
  let calls = 0
  let toBlock = to
  while (toBlock >= from) {
    const fromBlock = Math.max(from, toBlock - chunk + 1)
    for (const c of contracts) {
      const evs: any[] = await c.queryFilter(c.filters.ActionsProcessed(networkId), fromBlock, toBlock)
      calls++
      for (const e of evs) keys.push(`${e.transactionHash}:${e.index}`)
      if (delayMs) await sleep(delayMs)
    }
    toBlock = fromBlock - 1
  }
  return { keys: keys.sort(), calls }
}

// The adaptive walk: the real walkLogsBackward, with the same two-contract read
// as reconstructCheckpointData does in each window.
async function scanAdaptive(rpc: string, startChunk: number, from: number, to: number, delayMs = 0) {
  const provider = new JsonRpcProvider(rpc)
  const contracts = [new Contract(CAW_ACTIONS_ADDRESS, cawActionsAbi as any, provider)]
  if (CAW_ACTIONS_ERC1271_ADDRESS) contracts.push(new Contract(CAW_ACTIONS_ERC1271_ADDRESS, cawActionsAbi as any, provider))
  const shrinks: string[] = []
  let calls = 0
  const walked = await walkLogsBackward<any>({
    latest: to,
    floor: from,
    chunk: startChunk,
    fetchWindow: async (fromBlock, toBlock) => {
      const got: any[] = []
      for (const c of contracts) {
        calls++
        got.push(...(await c.queryFilter(c.filters.ActionsProcessed(networkId), fromBlock, toBlock)))
        if (delayMs) await sleep(delayMs)
      }
      return got
    },
    onWindow: () => false,
    onShrink: (rejected, next) => shrinks.push(`${rejected}->${next}`),
  })
  const keys = walked.events.map(e => `${e.transactionHash}:${e.index}`).sort()
  return { keys, calls, shrinks, finalChunk: walked.chunk }
}

async function main() {
  const latest = await new JsonRpcProvider(REF).getBlockNumber()
  const from = FROM_ARG ? Number(FROM_ARG) : latest - 49_999
  const to = from + 49_999
  console.log(`range ${from}..${to} (50,000 blocks), networkId ${networkId}, contracts: ${CAW_ACTIONS_ERC1271_ADDRESS ? 2 : 1}`)
  const a = await scan(REF, 50_000, from, to)
  const b = await scan(REF, 2_000, from, to)
  const same = (x: string[], y: string[]) => JSON.stringify(x) === JSON.stringify(y)
  console.log(`reference, chunk 50000: ${a.keys.length} logs in ${a.calls} calls`)
  console.log(`reference, chunk  2000: ${b.keys.length} logs in ${b.calls} calls / identical to chunk 50000: ${same(a.keys, b.keys)}`)
  try {
    await scan(CAPPED, 50_000, from, to)
    console.log('capped,    chunk 50000: accepted')
  } catch (e: any) {
    console.log(`capped,    chunk 50000: rejected (${String(e.shortMessage || e.message).slice(0, 140)})`)
  }
  const c = await scanAdaptive(CAPPED, 50_000, from, to, 150)
  console.log(`capped,    adaptive from 50000: ${c.keys.length} logs in ${c.calls} calls, shrinks [${c.shrinks.join(', ')}], final window ${c.finalChunk} / identical to reference: ${same(a.keys, c.keys)}`)
}
main().catch(e => { console.error(e); process.exit(1) })

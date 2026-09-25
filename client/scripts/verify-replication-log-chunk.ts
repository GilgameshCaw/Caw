// Verify the ActionsProcessed scan in reconstructCheckpointData against live
// RPCs: the same block range must yield the same logs whatever the chunk
// size, and a capped RPC must work with a small chunk. Read-only.
// Usage: npx tsx scripts/verify-replication-log-chunk.ts <referenceRpcUrl> [cappedRpcUrl] [networkId]
import { JsonRpcProvider, Contract } from 'ethers'
import { cawActionsAbi } from '../src/abi/generated'
import { CAW_ACTIONS_ADDRESS, CAW_ACTIONS_ERC1271_ADDRESS } from '../src/abi/addresses'

const [REF, CAPPED = 'https://sepolia.base.org', NET = '1'] = process.argv.slice(2)
if (!REF) {
  console.error('usage: npx tsx scripts/verify-replication-log-chunk.ts <referenceRpcUrl> [cappedRpcUrl] [networkId]')
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

async function main() {
  const latest = await new JsonRpcProvider(REF).getBlockNumber()
  const from = latest - 49_999
  console.log(`range ${from}..${latest} (50,000 blocks), networkId ${networkId}, contracts: ${CAW_ACTIONS_ERC1271_ADDRESS ? 2 : 1}`)
  const a = await scan(REF, 50_000, from, latest)
  const b = await scan(REF, 2_000, from, latest)
  const same = (x: string[], y: string[]) => JSON.stringify(x) === JSON.stringify(y)
  console.log(`reference, chunk 50000: ${a.keys.length} logs in ${a.calls} calls`)
  console.log(`reference, chunk  2000: ${b.keys.length} logs in ${b.calls} calls / identical to chunk 50000: ${same(a.keys, b.keys)}`)
  try {
    await scan(CAPPED, 50_000, from, latest)
    console.log('capped,    chunk 50000: accepted')
  } catch (e: any) {
    console.log(`capped,    chunk 50000: rejected (${String(e.shortMessage || e.message).slice(0, 140)})`)
  }
  const c = await scan(CAPPED, 1_000, from, latest, 150)
  console.log(`capped,    chunk  1000: ${c.keys.length} logs in ${c.calls} calls / identical to reference: ${same(a.keys, c.keys)}`)
}
main().catch(e => { console.error(e); process.exit(1) })

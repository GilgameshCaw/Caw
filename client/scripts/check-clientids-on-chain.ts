// scripts/check-clientids-on-chain.ts
//
// One-shot: scan all ActionsProcessed events on chain and bucket the
// indexed clientId topic. Lets us verify whether clients other than
// CLIENT_ID=1 have ever submitted actions to the production CawActions
// contract.
//
// Usage:  npx tsx scripts/check-clientids-on-chain.ts

import 'dotenv/config'
import { id, JsonRpcProvider } from 'ethers'
import { CAW_ACTIONS_ADDRESS } from '../src/abi/addresses'
import { scanLogsForward } from '../src/utils/chunkedLogs'

async function main() {
  const url = process.env.L2_RPC_URL_HTTP || process.env.L2_RPC_URL
  if (!url) throw new Error('Need L2_RPC_URL_HTTP or L2_RPC_URL')
  const provider = new JsonRpcProvider(url)
  const latest = await provider.getBlockNumber()
  const startEnv = process.env.SCAN_FROM_BLOCK
  const start = startEnv ? Number(startEnv) : Math.max(0, latest - 8_000_000)
  // Deployed testnet contract is the older signature with one bytes arg.
  // Newer source emits indexed clientId/validatorId — toggle this when we
  // redeploy.
  const sig = id('ActionsProcessed(bytes)')

  console.log(`Scanning ${CAW_ACTIONS_ADDRESS} from block ${start} to ${latest}…`)
  const logs = await scanLogsForward(
    provider,
    CAW_ACTIONS_ADDRESS,
    [sig],
    start,
    latest,
    {
      chunkBlocks: 10_000,
      maxWindows: 100_000,
      onProgress: (from, to, n) => {
        if (n > 0) console.log(`  chunk ${from}..${to}: ${n} events`)
      },
    },
  )
  console.log(`Got ${logs.length} ActionsProcessed events`)
  const counts = new Map<number, number>()
  for (const log of logs) {
    if (!log.topics?.[1]) continue
    const cid = Number(BigInt(log.topics[1]))
    counts.set(cid, (counts.get(cid) ?? 0) + 1)
  }
  console.log('clientId → ActionsProcessed event count:')
  for (const [cid, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cid}: ${n}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })

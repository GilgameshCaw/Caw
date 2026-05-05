// scripts/backfill-l1-deposits.ts
//
// One-shot scan of historical L1 CawProfile.Deposited events. Fills
// in the deposit ledger for users who deposited before the live
// DepositWatcher started. Idempotent: skips events whose
// (txHash, logIndex) already exist as DEPOSIT rows in
// CawOwnershipSnapshot.
//
// Uses scanLogsForward (chunked eth_getLogs) so it works on free-tier
// RPCs that cap at ~50K blocks per request. Per
// project_free_rpc_50k_block_cap.md, NEVER queryFilter(0, 'latest').
//
// Usage:
//   npx tsx scripts/backfill-l1-deposits.ts                       # from contract genesis
//   npx tsx scripts/backfill-l1-deposits.ts --from 7900000        # from a specific block
//   npx tsx scripts/backfill-l1-deposits.ts --to 8200000          # up to a specific block
//   npx tsx scripts/backfill-l1-deposits.ts --chunk 5000          # smaller chunks for picky RPCs

import 'dotenv/config'
import { ethers } from 'ethers'
import { prisma } from '../src/prismaClient'
import { CAW_NAMES_ADDRESS } from '../src/abi/addresses'
import { makeJsonRpcProvider, getL1HttpRpcUrl } from '../src/utils/rpcProvider'
import { scanLogsForward } from '../src/utils/chunkedLogs'

const args = process.argv.slice(2)
const argFrom = args.indexOf('--from') >= 0 ? Number(args[args.indexOf('--from') + 1]) : undefined
const argTo = args.indexOf('--to') >= 0 ? Number(args[args.indexOf('--to') + 1]) : undefined
const argChunk = args.indexOf('--chunk') >= 0 ? Number(args[args.indexOf('--chunk') + 1]) : undefined

const CAW_CLIENT_ID = (() => {
  const raw = process.env.CLIENT_ID
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('CLIENT_ID is required (set it in client/.env)')
  }
  return n
})()

const L1_CHAIN_ID = Number(process.env.L1_CHAIN_ID || '11155111')

const DEPOSITED_ABI = [
  'event Deposited(uint32 indexed cawClientId, uint32 indexed tokenId, uint256 amount, uint32 indexed lzDestId, address depositor)',
]

function logProgress(msg: string) {
  console.log(`[deposit-backfill] ${msg}`)
}

async function main() {
  const rpcUrl = getL1HttpRpcUrl()
  if (!rpcUrl) {
    console.error('[deposit-backfill] L1_RPC_URL_HTTP / L1_RPC_URL not configured')
    process.exit(1)
  }
  const provider = makeJsonRpcProvider(rpcUrl, L1_CHAIN_ID)
  const contract = new ethers.Contract(CAW_NAMES_ADDRESS, DEPOSITED_ABI, provider)

  const head = await provider.getBlockNumber()
  const fromBlock = argFrom ?? 0
  const toBlock = argTo ?? head
  if (fromBlock > toBlock) {
    console.error(`[deposit-backfill] fromBlock (${fromBlock}) > toBlock (${toBlock})`)
    process.exit(1)
  }
  logProgress(`scanning L1 contract=${CAW_NAMES_ADDRESS} blocks=${fromBlock}..${toBlock} (head=${head})`)

  // Filter on the indexed cawClientId topic at the RPC level so the
  // backfill only sees OUR client's deposits. Multi-client deployments
  // share the same L1 contract; without the filter we'd scan ALL
  // deposits and discard most.
  const eventFilter = contract.filters.Deposited(CAW_CLIENT_ID)
  const topicsRaw = (eventFilter as any).topics ?? []
  const topics = (Array.isArray(topicsRaw) ? topicsRaw : [topicsRaw]) as (string | string[] | null)[]

  let scanned = 0
  let written = 0
  let skipped = 0
  let failed = 0
  const startedAt = Date.now()

  // Cache block timestamps — multiple events can share a block, and
  // each getBlock RPC is expensive on free tiers.
  const tsCache = new Map<number, Date>()
  const getTs = async (blockNumber: number): Promise<Date> => {
    const cached = tsCache.get(blockNumber)
    if (cached) return cached
    try {
      const block = await provider.getBlock(blockNumber)
      const ts = new Date(Number(block?.timestamp ?? 0) * 1000)
      tsCache.set(blockNumber, ts)
      return ts
    } catch {
      // RPC failure → fall back to NOW. Better than dropping the row.
      return new Date()
    }
  }

  const logs = await scanLogsForward(provider, CAW_NAMES_ADDRESS, topics, fromBlock, toBlock, {
    chunkBlocks: argChunk ?? 10_000,
    maxWindows: 10_000, // one-shot, can run for a while; cap is just a sanity ceiling
    onProgress: (a, b, n) => {
      scanned += n
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
      logProgress(`  scanned blocks ${a}..${b} (+${n} logs, ${scanned} total, ${elapsed}s)`)
    },
  })

  logProgress(`found ${logs.length} Deposited event(s); writing rows…`)

  const iface = new ethers.Interface(DEPOSITED_ABI)
  for (const log of logs) {
    let parsed
    try {
      parsed = iface.parseLog({ topics: log.topics as string[], data: log.data })
    } catch {
      continue
    }
    if (!parsed) continue
    const tokenId = Number(parsed.args[1])
    const amount: bigint = BigInt(parsed.args[2])
    const txHash = log.transactionHash
    const logIndex = (log as any).index ?? (log as any).logIndex ?? 0
    const blockNumber = BigInt(log.blockNumber)
    const blockTimestamp = await getTs(log.blockNumber)

    try {
      // Write the DEPOSIT row directly. Bypasses recordDeposit() —
      // backfill doesn't need the snapshotter's in-memory math (we
      // can't trust historical multiplier state anyway). We only
      // care about the per-bucket delta for the chart, which is
      // exactly what recordDeposit's `delta` field captured.
      const existing = await prisma.cawOwnershipSnapshot.findFirst({
        where: { txHash, logIndex, reason: 'DEPOSIT' },
        select: { id: true },
      })
      if (existing) {
        skipped++
        continue
      }
      await prisma.cawOwnershipSnapshot.create({
        data: {
          tokenId,
          blockNumber,
          blockTimestamp,
          txHash,
          logIndex,
          actionIndex: null,
          // Historical chain ownership/multiplier/balance are
          // unknowable from event logs alone. The chart reads
          // `delta` (the bucket aggregate), not these snapshot
          // fields, so 0 here is honest.
          ownership: '0',
          multiplier: '0',
          balance: '0',
          delta: amount.toString(),
          reason: 'DEPOSIT',
          actionType: null,
          counterpartyTokenId: null,
        },
      })
      written++
    } catch (err: any) {
      console.warn(`[deposit-backfill] failed tokenId=${tokenId} tx=${txHash}:`, err?.message)
      failed++
    }
  }

  logProgress(`Done. wrote=${written}, skipped=${skipped} (already-present), failed=${failed}, of ${logs.length} candidates.`)
  await prisma.$disconnect()
}

main().catch(err => {
  console.error('[deposit-backfill] FAILED:', err)
  process.exit(1)
})

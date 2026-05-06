// scripts/backfill-mint-and-deposits.ts
//
// Recover historical `mintAndDeposit` deposits that were never indexed.
//
// CONTEXT: pre-2026-05-06, CawProfile.mintAndDeposit transferred CAW
// into the contract and incremented totalCaw without emitting Deposited
// (commit 4f5c090 added the emit; everything BEFORE that commit is on
// chain without an indexable event). The activity ledger therefore shows
// a fraction of true deposits, and `cawProfileL2.totalCaw()` reads
// hugely above sum-of-recorded-deposits.
//
// FIX: walk the CAW token's `Transfer` events with `to = CawProfile`,
// and for each one check whether the same tx ALSO contains a CawProfile
// NFT mint (`Transfer(0x0, owner, tokenId)`). If yes, that's a
// mintAndDeposit. Synthesize a DEPOSIT row in CawOwnershipSnapshot.
//
// Why same-tx pairing (vs just CAW-Transfer-to-cawProfile): the regular
// `depositFor` path also transfers CAW into the contract, AND fires a
// Deposited event. We don't want to double-count those — they're already
// captured by backfill-l1-deposits.ts. Same-tx pairing with an NFT mint
// uniquely identifies the mintAndDeposit shape: the NFT mint wouldn't
// fire on a depositFor call (no new token).
//
// Why not look at the contract's CAW balance: it includes accrued fees
// and token-balance dust we'd have to subtract out. Event-pairing is
// deterministic and tx-by-tx auditable.
//
// Idempotent: skips if a (txHash, logIndex, reason='DEPOSIT') row
// already exists. Safe to re-run.
//
// Usage:
//   npx tsx scripts/backfill-mint-and-deposits.ts                # auto-detect deploy block → head
//   npx tsx scripts/backfill-mint-and-deposits.ts --from 7900000 # specific start
//   npx tsx scripts/backfill-mint-and-deposits.ts --to 8200000   # specific end
//   npx tsx scripts/backfill-mint-and-deposits.ts --chunk 5000   # smaller eth_getLogs windows
//   npx tsx scripts/backfill-mint-and-deposits.ts --dry-run      # report counts, write nothing
//
// Start-block resolution: --from > $L1_DEPLOY_BLOCK > binary-search
// eth_getCode. Pass an explicit hint when you know it (saves ~25 RPC
// calls); omit and let the script find it. The chain's genesis block is
// almost always wrong as a default — backfill scripts should never scan
// the empty pre-deploy range.

import 'dotenv/config'
import { ethers } from 'ethers'
import { prisma } from '../src/prismaClient'
import { CAW_ADDRESS, CAW_NAMES_ADDRESS } from '../src/abi/addresses'
import { makeJsonRpcProvider, getL1HttpRpcUrl } from '../src/utils/rpcProvider'
import { scanLogsForward, findContractDeployBlock } from '../src/utils/chunkedLogs'

const args = process.argv.slice(2)
const argFrom = args.indexOf('--from') >= 0 ? Number(args[args.indexOf('--from') + 1]) : undefined
const argTo = args.indexOf('--to') >= 0 ? Number(args[args.indexOf('--to') + 1]) : undefined
const argChunk = args.indexOf('--chunk') >= 0 ? Number(args[args.indexOf('--chunk') + 1]) : undefined
const dryRun = args.includes('--dry-run')

const L1_CHAIN_ID = Number(process.env.L1_CHAIN_ID || '11155111')

// Pre-image: keccak256("Transfer(address,address,uint256)") — same topic
// for ERC20 Transfer and ERC721 Transfer (the spec is shared). Distinguish
// at parse time by which contract emitted it (CAW vs CawProfile) and the
// `from` value (zero address = NFT mint).
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO_TOPIC = '0x' + '00'.repeat(32)

function logProgress(msg: string) {
  console.log(`[mintAndDeposit-backfill] ${msg}`)
}

async function main() {
  const rpcUrl = getL1HttpRpcUrl()
  if (!rpcUrl) {
    console.error('[mintAndDeposit-backfill] L1_RPC_URL_HTTP / L1_RPC_URL not configured')
    process.exit(1)
  }
  const provider = makeJsonRpcProvider(rpcUrl, L1_CHAIN_ID)

  const head = await provider.getBlockNumber()

  // Pick fromBlock in priority order: explicit --from > L1_DEPLOY_BLOCK env >
  // auto-detect via binary-search eth_getCode. The auto-detect is one-shot
  // (~25 RPC calls on Sepolia) and amortizes against multi-million-block
  // dead range that defaulting to 0 would otherwise scan empty.
  let fromBlock: number
  if (argFrom !== undefined) {
    fromBlock = argFrom
  } else if (process.env.L1_DEPLOY_BLOCK) {
    fromBlock = Number(process.env.L1_DEPLOY_BLOCK)
    if (!Number.isFinite(fromBlock)) {
      console.error(`[mintAndDeposit-backfill] L1_DEPLOY_BLOCK="${process.env.L1_DEPLOY_BLOCK}" is not a number`)
      process.exit(1)
    }
  } else {
    logProgress('detecting CawProfile deployment block via binary search…')
    fromBlock = await findContractDeployBlock(provider, CAW_NAMES_ADDRESS, head)
    if (fromBlock === 0) {
      console.error(`[mintAndDeposit-backfill] CawProfile (${CAW_NAMES_ADDRESS}) has no code at head — wrong RPC chain?`)
      process.exit(1)
    }
    logProgress(`detected deployment at block ${fromBlock}`)
  }
  const toBlock = argTo ?? head
  if (fromBlock > toBlock) {
    console.error(`[mintAndDeposit-backfill] fromBlock (${fromBlock}) > toBlock (${toBlock})`)
    process.exit(1)
  }
  logProgress(`scanning blocks=${fromBlock}..${toBlock} (head=${head}) dryRun=${dryRun}`)

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
      return new Date()
    }
  }

  // Pass 1: NFT mints on CawProfile. Transfer(from = 0x0, to, tokenId).
  // Topics = [Transfer, indexed_from=0, ...]. Filtering on indexed_from at
  // the RPC level is a major win — without it we'd download every token
  // transfer ever and discard mint-only matches client-side.
  logProgress('pass 1/2: scanning CawProfile NFT mints (Transfer from 0x0)…')
  const mintLogs = await scanLogsForward(
    provider,
    CAW_NAMES_ADDRESS,
    [TRANSFER_TOPIC, ZERO_TOPIC],
    fromBlock,
    toBlock,
    {
      chunkBlocks: argChunk ?? 10_000,
      maxWindows: 10_000,
      onProgress: (a, b, n) => logProgress(`  scanned blocks ${a}..${b} (+${n} mints)`),
    },
  )
  logProgress(`pass 1 found ${mintLogs.length} NFT mint event(s)`)

  // Index mints by tx hash. mintAndDeposit has one mint per tx; we use a
  // Map (txHash → mint log) so pass 2 can find the matching mint cheaply.
  const mintByTx = new Map<string, ethers.Log>()
  for (const log of mintLogs) {
    mintByTx.set(log.transactionHash, log as ethers.Log)
  }

  // Pass 2: CAW ERC20 Transfers TO the CawProfile contract. Topics =
  // [Transfer, _from (any), indexed_to = cawProfile]. The to-topic
  // restriction means we only pull deposits, not all token movement.
  const cawProfileTopic = '0x' + CAW_NAMES_ADDRESS.toLowerCase().slice(2).padStart(64, '0')
  logProgress(`pass 2/2: scanning CAW ERC20 Transfers to ${CAW_NAMES_ADDRESS}…`)
  const cawLogs = await scanLogsForward(
    provider,
    CAW_ADDRESS,
    [TRANSFER_TOPIC, null, cawProfileTopic],
    fromBlock,
    toBlock,
    {
      chunkBlocks: argChunk ?? 10_000,
      maxWindows: 10_000,
      onProgress: (a, b, n) => logProgress(`  scanned blocks ${a}..${b} (+${n} CAW transfers)`),
    },
  )
  logProgress(`pass 2 found ${cawLogs.length} CAW→CawProfile transfer event(s)`)

  // Match: a CAW transfer counts as a mintAndDeposit if its tx ALSO
  // contains an NFT mint. The mint log gives us the (owner, tokenId).
  const erc20Iface = new ethers.Interface([
    'event Transfer(address indexed from, address indexed to, uint256 value)',
  ])
  const erc721Iface = new ethers.Interface([
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  ])

  let matched = 0
  let skipped = 0
  let written = 0
  let failed = 0
  let totalAmount = 0n

  for (const cawLog of cawLogs) {
    const mintLog = mintByTx.get(cawLog.transactionHash)
    if (!mintLog) continue // depositFor / fee transfers / other → not us
    matched++

    let cawParsed
    let mintParsed
    try {
      cawParsed = erc20Iface.parseLog({
        topics: cawLog.topics as string[],
        data: cawLog.data,
      })
      mintParsed = erc721Iface.parseLog({
        topics: mintLog.topics as string[],
        data: mintLog.data,
      })
    } catch {
      continue
    }
    if (!cawParsed || !mintParsed) continue

    const tokenId = Number(mintParsed.args[2])
    const amount: bigint = BigInt(cawParsed.args[2])
    if (amount === 0n) continue // mint without deposit (mintAndAuth path)

    const txHash = cawLog.transactionHash
    const logIndex = (cawLog as any).index ?? (cawLog as any).logIndex ?? 0
    const blockNumber = BigInt(cawLog.blockNumber)

    try {
      // Idempotency: deposit-backfill / live indexer / earlier runs of
      // this script may have already written a row for this exact log
      // position. The (txHash, logIndex) pair uniquely identifies a log
      // entry chain-wide.
      const existing = await prisma.cawOwnershipSnapshot.findFirst({
        where: { txHash, logIndex, reason: 'DEPOSIT' },
        select: { id: true },
      })
      if (existing) {
        skipped++
        continue
      }

      if (!dryRun) {
        const blockTimestamp = await getTs(cawLog.blockNumber)
        await prisma.cawOwnershipSnapshot.create({
          data: {
            tokenId,
            blockNumber,
            blockTimestamp,
            txHash,
            logIndex,
            actionIndex: null,
            // Same convention as backfill-l1-deposits: chart reads only
            // delta + bucket, the snapshot fields are unknowable from
            // event logs alone.
            ownership: '0',
            multiplier: '0',
            balance: '0',
            delta: amount.toString(),
            reason: 'DEPOSIT',
            actionType: null,
            counterpartyTokenId: null,
          },
        })
      }
      written++
      totalAmount += amount
    } catch (err: any) {
      console.warn(`[mintAndDeposit-backfill] failed tokenId=${tokenId} tx=${txHash}:`, err?.message)
      failed++
    }
  }

  const totalCaw = totalAmount / 10n ** 18n
  logProgress(
    `Done. matched=${matched}, ${dryRun ? 'would-write' : 'wrote'}=${written}, ` +
    `skipped=${skipped} (already-present), failed=${failed}, ` +
    `total deposit volume = ${totalCaw} CAW (${totalAmount} wei).`,
  )
  await prisma.$disconnect()
}

main().catch(err => {
  console.error('[mintAndDeposit-backfill] FAILED:', err)
  process.exit(1)
})

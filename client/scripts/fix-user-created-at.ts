// scripts/fix-user-created-at.ts
//
// Recover User.createdAt from the on-chain block timestamp of that
// user's username NFT mint on CAW_NAMES (CawProfile) on L1 Sepolia.
//
// CONTEXT: on some nodes, every User.createdAt got reset to the
// install/import timestamp (Prisma column default CURRENT_TIMESTAMP
// fired on a bulk import/migration instead of the row's true creation
// time). Every user then looks "new this week" forever, which breaks
// the newMembersThisWeek stat. Reported by nyaromesama + zinsanjp;
// Zin already ran an ad-hoc version of this successfully (3,934 rows
// fixed on one node).
//
// FIX: walk CawProfile's `Transfer(from=0x0, to, tokenId)` mint events
// (same scan as backfill-mint-and-deposits.ts pass 1), take the mint
// block's timestamp as the true createdAt, and update User rows keyed
// by User.tokenId (unique) whose stored createdAt differs.
//
// Idempotent: re-running --apply after a successful apply finds every
// row already correct (skipped, not rewritten). Safe to re-run.
//
// Usage:
//   npx tsx scripts/fix-user-created-at.ts                          # dry-run (default), report only
//   npx tsx scripts/fix-user-created-at.ts --apply                  # write the fixes
//   npx tsx scripts/fix-user-created-at.ts --from 10735524          # explicit scan start (CLI)
//   FIX_SCAN_FROM_BLOCK=10735524 npx tsx scripts/fix-user-created-at.ts --apply
//   L1_RPC_URL=https://your-rpc npx tsx scripts/fix-user-created-at.ts --apply
//
// RPC gotchas (the whole reason the ad-hoc version was painful — read
// before running against a new node):
//
//   1. findContractDeployBlock() binary-searches via eth_getCode, which
//      is UNRELIABLE on non-archive RPCs (publicnode/drpc report "has
//      code" even for pre-deploy blocks because they don't retain
//      historical state — the binary search can converge on a wrong,
//      too-early block). Set FIX_SCAN_FROM_BLOCK (or pass --from) to
//      skip the binary search entirely. Known-good value for the
//      current CAW_NAMES deployment on Sepolia (found by Zin):
//        FIX_SCAN_FROM_BLOCK=10735524
//      This script does NOT hardcode that number — it only reads it
//      from the env/CLI so operators on a different deployment aren't
//      silently pointed at the wrong block.
//
//   2. Free-tier RPCs (drpc.org and similar) cap batched JSON-RPC
//      requests very low (~3 at a time). scanLogsForward/scanLogsBackward
//      already chunk eth_getLogs by block range (chunkBlocks, default
//      10_000) — that part needs no extra knob. But this script ALSO
//      calls eth_getBlockByNumber once per distinct mint block to read
//      the timestamp, which is a separate call pattern not covered by
//      chunkedLogs.ts. That fan-out is batched here via FIX_BATCH_SIZE
//      (default 3) — lower it further if a node still 429s.
//
// Env:
//   L1_RPC_URL          - required (or L1_RPC_URL_HTTP; see getL1HttpRpcUrl).
//                          Respects L1_RPC_SECRET basic-auth automatically —
//                          never put secrets directly in the URL.
//   FIX_SCAN_FROM_BLOCK  - optional. Skips findContractDeployBlock binary
//                          search when set. See gotcha #1 above.
//   FIX_BATCH_SIZE       - optional, default 3. Max concurrent
//                          eth_getBlockByNumber calls in flight. See
//                          gotcha #2 above.
//
// CLI flags:
//   --apply    write the fixes (default is dry-run: report only, write nothing)
//   --from N   explicit scan start block (overrides FIX_SCAN_FROM_BLOCK)
//   --to N     explicit scan end block (default: chain head)
//   --chunk N  eth_getLogs window size passed to scanLogsForward (default 10_000)

import 'dotenv/config'
import { ethers } from 'ethers'
import { prisma } from '../src/prismaClient'
import { CAW_NAMES_ADDRESS } from '../src/abi/addresses'
import { makeJsonRpcProvider, getL1HttpRpcUrl } from '../src/utils/rpcProvider'
import { scanLogsForward, findContractDeployBlock } from '../src/utils/chunkedLogs'

const args = process.argv.slice(2)
const argFrom = args.indexOf('--from') >= 0 ? Number(args[args.indexOf('--from') + 1]) : undefined
const argTo = args.indexOf('--to') >= 0 ? Number(args[args.indexOf('--to') + 1]) : undefined
const argChunk = args.indexOf('--chunk') >= 0 ? Number(args[args.indexOf('--chunk') + 1]) : undefined
const apply = args.includes('--apply')
const dryRun = !apply

const L1_CHAIN_ID = Number(process.env.L1_CHAIN_ID || '11155111')
const BATCH_SIZE = Number(process.env.FIX_BATCH_SIZE || '3')

// Pre-image: keccak256("Transfer(address,address,uint256)") — shared topic
// for ERC20 and ERC721 Transfer events (spec is identical). CAW_NAMES is
// the ERC721 CawProfile contract, so every match here is an NFT transfer;
// filtering the indexed `from` topic to the zero address restricts to mints.
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO_TOPIC = '0x' + '00'.repeat(32)

function logProgress(msg: string) {
  console.log(`[fix-user-created-at] ${msg}`)
}

/** Run async `fn` over `items` with at most `batchSize` in flight at once. */
async function mapWithConcurrency<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i])
    }
  }
  const workers = Array.from({ length: Math.max(1, batchSize) }, () => worker())
  await Promise.all(workers)
  return results
}

async function main() {
  const rpcUrl = getL1HttpRpcUrl()
  if (!rpcUrl) {
    console.error('[fix-user-created-at] L1_RPC_URL_HTTP / L1_RPC_URL not configured')
    process.exit(1)
  }
  const provider = makeJsonRpcProvider(rpcUrl, L1_CHAIN_ID)

  const head = await provider.getBlockNumber()

  // Pick fromBlock in priority order: explicit --from > FIX_SCAN_FROM_BLOCK
  // env > auto-detect via binary-search eth_getCode. See gotcha #1 in the
  // header docstring — the binary search is unreliable on non-archive
  // free-tier RPCs, so operators hitting that should always supply one of
  // the explicit overrides instead of relying on auto-detect.
  let fromBlock: number
  if (argFrom !== undefined) {
    fromBlock = argFrom
  } else if (process.env.FIX_SCAN_FROM_BLOCK) {
    fromBlock = Number(process.env.FIX_SCAN_FROM_BLOCK)
    if (!Number.isFinite(fromBlock)) {
      console.error(`[fix-user-created-at] FIX_SCAN_FROM_BLOCK="${process.env.FIX_SCAN_FROM_BLOCK}" is not a number`)
      process.exit(1)
    }
  } else {
    logProgress('detecting CawProfile deployment block via binary search (may be unreliable on non-archive RPCs — prefer FIX_SCAN_FROM_BLOCK)…')
    fromBlock = await findContractDeployBlock(provider, CAW_NAMES_ADDRESS, head)
    if (fromBlock === 0) {
      console.error(`[fix-user-created-at] CawProfile (${CAW_NAMES_ADDRESS}) has no code at head — wrong RPC chain?`)
      process.exit(1)
    }
    logProgress(`detected deployment at block ${fromBlock}`)
  }
  const toBlock = argTo ?? head
  if (fromBlock > toBlock) {
    console.error(`[fix-user-created-at] fromBlock (${fromBlock}) > toBlock (${toBlock})`)
    process.exit(1)
  }
  logProgress(`scanning blocks=${fromBlock}..${toBlock} (head=${head}) mode=${dryRun ? 'DRY-RUN' : 'APPLY'} batchSize=${BATCH_SIZE}`)

  // Scan CawProfile NFT mints: Transfer(from = 0x0, to, tokenId).
  // Filtering on indexed `from` at the RPC level avoids downloading every
  // token transfer ever and discarding non-mints client-side.
  logProgress('scanning CawProfile NFT mints (Transfer from 0x0)…')
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
  logProgress(`found ${mintLogs.length} NFT mint event(s)`)

  const erc721Iface = new ethers.Interface([
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  ])

  // tokenId -> mint block number. One mint per tokenId; last-write-wins is
  // fine here since a tokenId can never be minted twice.
  const mintBlockByTokenId = new Map<number, number>()
  for (const log of mintLogs) {
    try {
      const parsed = erc721Iface.parseLog({ topics: log.topics as string[], data: log.data })
      if (!parsed) continue
      const tokenId = Number(parsed.args[2])
      mintBlockByTokenId.set(tokenId, log.blockNumber)
    } catch {
      continue
    }
  }
  logProgress(`resolved ${mintBlockByTokenId.size} unique tokenId → mint-block mapping(s)`)

  // Batch-fetch block timestamps for every distinct mint block. Kept
  // separate from scanLogsForward's own eth_getLogs chunking — this is a
  // different RPC method (eth_getBlockByNumber) with its own fan-out, and
  // free-tier RPCs (drpc.org etc.) cap concurrent batched requests very
  // low. FIX_BATCH_SIZE controls concurrency here.
  const distinctBlocks = Array.from(new Set(mintBlockByTokenId.values()))
  logProgress(`fetching timestamps for ${distinctBlocks.length} distinct block(s)…`)
  const tsByBlock = new Map<number, Date>()
  let fetched = 0
  await mapWithConcurrency(distinctBlocks, BATCH_SIZE, async (blockNumber) => {
    const block = await provider.getBlock(blockNumber)
    if (block) {
      tsByBlock.set(blockNumber, new Date(Number(block.timestamp) * 1000))
    }
    fetched++
    if (fetched % 200 === 0 || fetched === distinctBlocks.length) {
      logProgress(`  fetched ${fetched}/${distinctBlocks.length} block timestamps`)
    }
  })

  const tokenIdToCreatedAt = new Map<number, Date>()
  for (const [tokenId, blockNumber] of mintBlockByTokenId) {
    const ts = tsByBlock.get(blockNumber)
    if (ts) tokenIdToCreatedAt.set(tokenId, ts)
  }

  // Load every User row keyed by tokenId (unique) and diff against the
  // resolved mint timestamp.
  const users = await prisma.user.findMany({
    select: { id: true, tokenId: true, username: true, createdAt: true },
  })
  logProgress(`loaded ${users.length} User row(s) from DB`)

  interface Change {
    id: number
    tokenId: number
    username: string
    oldCreatedAt: Date
    newCreatedAt: Date
  }
  const changes: Change[] = []
  let alreadyCorrect = 0
  let noMintFound = 0

  for (const user of users) {
    const newCreatedAt = tokenIdToCreatedAt.get(user.tokenId)
    if (!newCreatedAt) {
      noMintFound++
      continue
    }
    if (newCreatedAt.getTime() === user.createdAt.getTime()) {
      alreadyCorrect++
      continue
    }
    changes.push({
      id: user.id,
      tokenId: user.tokenId,
      username: user.username,
      oldCreatedAt: user.createdAt,
      newCreatedAt,
    })
  }

  logProgress(
    `would-change=${changes.length}, already-correct=${alreadyCorrect}, ` +
    `no-mint-found=${noMintFound}, total-users=${users.length}`,
  )

  const sample = changes.slice(0, 10)
  if (sample.length > 0) {
    logProgress('sample of changes (up to 10):')
    for (const c of sample) {
      logProgress(
        `  user id=${c.id} username=${c.username} tokenId=${c.tokenId}: ` +
        `${c.oldCreatedAt.toISOString()} -> ${c.newCreatedAt.toISOString()}`,
      )
    }
  }

  if (dryRun) {
    logProgress('DRY-RUN complete. No rows written. Re-run with --apply to write these changes.')
    await prisma.$disconnect()
    return
  }

  logProgress(`APPLY: writing ${changes.length} row(s)…`)
  let written = 0
  let failed = 0
  for (const c of changes) {
    try {
      await prisma.user.update({
        where: { id: c.id },
        data: { createdAt: c.newCreatedAt },
      })
      written++
    } catch (err: any) {
      console.warn(`[fix-user-created-at] failed to update user id=${c.id} username=${c.username}:`, err?.message)
      failed++
    }
  }

  logProgress(`Done. wrote=${written}, failed=${failed}, skipped(already-correct)=${alreadyCorrect}, no-mint-found=${noMintFound}.`)
  await prisma.$disconnect()
}

main().catch(err => {
  console.error('[fix-user-created-at] FAILED:', err)
  process.exit(1)
})

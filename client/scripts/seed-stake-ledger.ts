// Bootstrap StakeLedger state on a fresh node.
//
// Why this exists: a brand-new install starts with an empty
// CawOwnershipCurrent table and no StakeLedgerState row. The ledger's
// boot path defaults to multiplier=1e18 — but on a non-fresh chain the
// real rewardMultiplier() has long since drifted (rewards accrue every
// time a user moves their CAW between staked / unstaked / liquidity
// positions on L2). On the very first ActionsProcessed event the
// per-event verifyMultiplier() check spots the mismatch and halts the
// ledger; daily reconciler can't repair it because the reconciler
// scans the past 24h of CawOwnershipSnapshot rows to find "active
// users," and we've written zero of those.
//
// This script reads the live chain state and seeds:
//   - StakeLedgerState.{multiplier, totalCaw} for the local clientId
//   - CawOwnershipCurrent for every minted token
//
// Idempotent: safe to re-run. The lastBlock / lastLogIndex stay 0 /-1
// so the next ActionsProcessed event the indexer sees applies normally.
//
// Usage:
//   cd client
//   npx tsx scripts/seed-stake-ledger.ts          # run for real
//   npx tsx scripts/seed-stake-ledger.ts --dry    # show what we'd write
//
// Reads NETWORK_ID (or legacy CLIENT_ID) + L2_RPC_URL_HTTP / L2_RPC_URL from .env.

import 'dotenv/config'
import { Contract } from 'ethers'
import { makeJsonRpcProvider, getL2HttpRpcUrl, getL1HttpRpcUrl } from '../src/utils/rpcProvider'
import { cawProfileLedgerAbi, cawProfileAbi } from '../src/abi/generated'
import { CAW_NAMES_L2_ADDRESS, CAW_NAMES_ADDRESS } from '../src/abi/addresses'
import { prisma } from '../src/prismaClient'
import { getNetworkId } from '../src/utils/networkId'

function requireClientId(): number {
  const raw = getNetworkId()
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) throw new Error('NETWORK_ID (or legacy CLIENT_ID) required')
  return n
}

// Retries a transient RPC failure (timeout, dropped connection, a public
// endpoint's momentary 5xx) with exponential backoff. This script runs
// unattended every 3h via cron (see cli/src/steps/install.js); one flaky
// request shouldn't fail the whole re-anchor and skip the pm2 restart that
// follows it.
async function retryWithBackoff<T>(fn: () => Promise<T>, maxAttempts = 3, baseDelayMs = 500): Promise<T> {
  let lastError: any
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      lastError = err
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1)
        console.warn(`  [seed-stake-ledger] attempt ${attempt}/${maxAttempts} transient failure: ${err?.message || err}. Retrying in ${delay}ms...`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }
  throw lastError
}

async function main() {
  const dryRun = process.argv.includes('--dry')
  const clientId = requireClientId()
  const rpcUrl = getL2HttpRpcUrl()
  if (!rpcUrl) throw new Error('L2 RPC not configured (L2_RPC_URL_HTTP / L2_RPC_URL)')

  const l2Provider = makeJsonRpcProvider(rpcUrl, 84532)
  const l2 = new Contract(CAW_NAMES_L2_ADDRESS, cawProfileLedgerAbi as any, l2Provider)

  // L2's CawProfileL2 doesn't expose nextId/totalSupply (only L1 CawProfile
  // does — IDs are minted on L1, mirrored to L2). Read the count from L1.
  const l1Url = getL1HttpRpcUrl()
  if (!l1Url) throw new Error('L1 RPC not configured (L1_RPC_URL_HTTP / L1_RPC_URL)')
  const l1Provider = makeJsonRpcProvider(l1Url, 11155111)
  const l1 = new Contract(CAW_NAMES_ADDRESS, cawProfileAbi as any, l1Provider)

  console.log(`[seed-stake-ledger] clientId=${clientId} dryRun=${dryRun}`)
  console.log(`[seed-stake-ledger] reading L2 state from ${CAW_NAMES_L2_ADDRESS}, L1 nextId from ${CAW_NAMES_ADDRESS}...`)

  // First read of multiplier/totalCaw is informational only — it's the
  // chain state at scan-start. We re-read both immediately before the DB
  // upsert below so the seeded value is as fresh as possible (rewardMultiplier
  // ticks on every CawActions submission; with a long ownership scan, the
  // value would drift mid-scan and verifyMultiplier would halt on first boot).
  // Reported by Zin (2026-05-11) after hitting exactly this race.
  const [multiplierAtStart, totalCawAtStart, nextId] = await retryWithBackoff(() => Promise.all([
    l2.rewardMultiplier(),
    l2.totalCaw(),
    l1.nextId(),
  ]))
  const maxId = Number(nextId) - 1
  console.log(`  rewardMultiplier (at scan start) = ${multiplierAtStart}`)
  console.log(`  totalCaw         (at scan start) = ${totalCawAtStart}`)
  console.log(`  nextId           = ${nextId} (will read tokens 1..${maxId})`)

  if (maxId < 1) {
    console.log('  No tokens minted — only seeding StakeLedgerState.')
  }

  // Read all token ownerships in batches. Prefer Multicall3
  // (deterministically deployed at the same address on every EVM chain via
  // CREATE2 -- Ethereum mainnet, every L2, and their testnets all share
  // 0xcA11...CA11 -- so this address does not need to change at mainnet
  // cutover), which collapses up to MULTICALL_BATCH individual eth_calls
  // into one request. Falls back to the original per-token Promise.all
  // chunking when Multicall3 isn't deployed on the target chain (e.g. a
  // local dev/mock network), so this never regresses below the prior
  // behavior.
  const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11'
  const MULTICALL3_ABI = [
    'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
  ]

  const ownership = new Map<number, bigint>()
  if (maxId >= 1) {
    let hasMulticall = false
    try {
      const code = await retryWithBackoff(() => l2Provider.getCode(MULTICALL3_ADDRESS))
      hasMulticall = Boolean(code && code !== '0x')
    } catch {
      hasMulticall = false
    }

    if (hasMulticall) {
      const multicall = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, l2Provider)
      const target = l2.target ? String(l2.target) : (l2 as any).address
      const MBATCH = 100
      for (let start = 1; start <= maxId; start += MBATCH) {
        const end = Math.min(start + MBATCH - 1, maxId)
        const ids = Array.from({ length: end - start + 1 }, (_, i) => start + i)
        const calls = ids.map(id => ({
          target,
          allowFailure: true,
          callData: l2.interface.encodeFunctionData('cawOwnership', [id]),
        }))
        // aggregate3 is declared payable in Multicall3's ABI; calling it
        // without .staticCall on a read-only provider makes ethers v6
        // attempt to send a transaction and throw UNSUPPORTED_OPERATION.
        // .staticCall forces an eth_call instead.
        const results = await retryWithBackoff(() => (multicall as any).aggregate3.staticCall(calls))
        for (let i = 0; i < results.length; i++) {
          const { success, returnData } = results[i]
          if (success && returnData && returnData !== '0x' && returnData.length >= 66) {
            try {
              const [v] = l2.interface.decodeFunctionResult('cawOwnership', returnData)
              const val = BigInt(v)
              if (val !== 0n) ownership.set(ids[i], val)
            } catch {
              // Skip a slot whose returnData doesn't decode as expected;
              // defensive against an unexpected ABI mismatch.
            }
          }
          // success === false is not expected in practice -- cawOwnership
          // returns 0 rather than reverting for unminted/out-of-range ids
          // (confirmed directly against live chain state) -- but
          // allowFailure: true means a future revert here is skipped
          // rather than failing the whole batch.
        }
        process.stdout.write(`\r  [multicall3] read ${end}/${maxId} (${ownership.size} non-zero owners so far)…`)
      }
      process.stdout.write('\n')
    } else {
      const BATCH = 50
      for (let start = 1; start <= maxId; start += BATCH) {
        const end = Math.min(start + BATCH - 1, maxId)
        const ids = Array.from({ length: end - start + 1 }, (_, i) => start + i)
        const reads = await retryWithBackoff(() => Promise.all(ids.map(async id => {
          try {
            const v = await l2.cawOwnership(id)
            return { id, v: BigInt(v) }
          } catch (err: any) {
            // Skip burned / non-existent slots quietly; they shouldn't appear
            // mid-range in the current contract design but be defensive.
            return { id, v: null as bigint | null }
          }
        })))
        for (const r of reads) {
          if (r.v !== null && r.v !== 0n) ownership.set(r.id, r.v)
        }
        process.stdout.write(`\r  read ${end}/${maxId} (${ownership.size} non-zero owners so far)…`)
      }
      process.stdout.write('\n')
    }
  }

  // Re-read multiplier + totalCaw RIGHT before the DB upsert. Tightens the
  // race window between "what we seed" and "what chain reports on the next
  // verifyMultiplier check after pm2 restart." There's still a tiny gap
  // (this read → DB write → pm2 reload), but it's measured in seconds vs.
  // the 60-90s ownership scan it would otherwise span.
  const [multiplier, totalCaw, headBlock] = await retryWithBackoff(() => Promise.all([
    l2.rewardMultiplier(),
    l2.totalCaw(),
    l2Provider.getBlockNumber(),
  ]))
  if (multiplier !== multiplierAtStart) {
    console.log(`  rewardMultiplier moved during scan: ${multiplierAtStart} → ${multiplier} (using fresh value)`)
  }
  if (totalCaw !== totalCawAtStart) {
    console.log(`  totalCaw moved during scan: ${totalCawAtStart} → ${totalCaw} (using fresh value)`)
  }

  const sumOwnership = [...ownership.values()].reduce((a, b) => a + b, 0n)
  console.log(`  sum(cawOwnership) = ${sumOwnership}`)
  // Note: sumOwnership reflects ownerships read DURING the scan, while
  // totalCaw is fresh as of after the scan — so a non-zero delta is
  // expected on an active chain. We surface it for diagnostic value but
  // don't treat any delta as an error.
  if (sumOwnership !== totalCaw) {
    console.log(`  (sum vs fresh totalCaw delta: ${totalCaw - sumOwnership} — expected on an active chain since reads aren't atomic)`)
  }

  if (dryRun) {
    console.log('[seed-stake-ledger] dry run — no DB writes.')
    return
  }

  // StakeLedgerState upsert. lastBlock = current chain head so the
  // snapshotter resumes from HERE forward — events before this point are
  // already incorporated in the seeded multiplier; replaying them would
  // double-count communal inflation. (Fresh installs: same cursor still
  // works, the indexer reads new events past the head as they arrive.)
  await prisma.stakeLedgerState.upsert({
    where: { networkId: clientId },
    create: {
      networkId: clientId,
      multiplier: String(multiplier),
      totalCaw: String(totalCaw),
      lastBlock: BigInt(headBlock),
      lastLogIndex: -1,
    },
    update: {
      multiplier: String(multiplier),
      totalCaw: String(totalCaw),
      lastBlock: BigInt(headBlock),
      lastLogIndex: -1,
    },
  })
  console.log(`  lastBlock seeded to L2 head ${headBlock}`)
  console.log(`[seed-stake-ledger] StakeLedgerState upserted for clientId=${clientId}`)

  // CawOwnershipCurrent — wipe + repopulate. Wiping (not just upserting)
  // ensures rows for tokens whose ownership has dropped to 0n on chain
  // get cleared locally too, since we skipped them in the in-memory map.
  await prisma.$transaction(async (tx) => {
    await tx.cawOwnershipCurrent.deleteMany({})
    if (ownership.size > 0) {
      await tx.cawOwnershipCurrent.createMany({
        data: Array.from(ownership.entries()).map(([tokenId, v]) => ({
          tokenId,
          ownership: String(v),
        })),
      })
    }
  })
  console.log(`[seed-stake-ledger] CawOwnershipCurrent populated with ${ownership.size} non-zero rows`)

  console.log('[seed-stake-ledger] Done. Restart pm2 so StakeLedger picks up the seeded state.')
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())

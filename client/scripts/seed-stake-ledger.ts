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
// Reads CLIENT_ID + L2_RPC_URL_HTTP / L2_RPC_URL from .env.

import 'dotenv/config'
import { Contract } from 'ethers'
import { makeJsonRpcProvider, getL2HttpRpcUrl, getL1HttpRpcUrl } from '../src/utils/rpcProvider'
import { cawProfileL2Abi, cawProfileAbi } from '../src/abi/generated'
import { CAW_NAMES_L2_ADDRESS, CAW_NAMES_ADDRESS } from '../src/abi/addresses'
import { prisma } from '../src/prismaClient'

function requireClientId(): number {
  const raw = process.env.CLIENT_ID
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) throw new Error('CLIENT_ID required')
  return n
}

async function main() {
  const dryRun = process.argv.includes('--dry')
  const clientId = requireClientId()
  const rpcUrl = getL2HttpRpcUrl()
  if (!rpcUrl) throw new Error('L2 RPC not configured (L2_RPC_URL_HTTP / L2_RPC_URL)')

  const l2Provider = makeJsonRpcProvider(rpcUrl, 84532)
  const l2 = new Contract(CAW_NAMES_L2_ADDRESS, cawProfileL2Abi as any, l2Provider)

  // L2's CawProfileL2 doesn't expose nextId/totalSupply (only L1 CawProfile
  // does — IDs are minted on L1, mirrored to L2). Read the count from L1.
  const l1Url = getL1HttpRpcUrl()
  if (!l1Url) throw new Error('L1 RPC not configured (L1_RPC_URL_HTTP / L1_RPC_URL)')
  const l1Provider = makeJsonRpcProvider(l1Url, 11155111)
  const l1 = new Contract(CAW_NAMES_ADDRESS, cawProfileAbi as any, l1Provider)

  console.log(`[seed-stake-ledger] clientId=${clientId} dryRun=${dryRun}`)
  console.log(`[seed-stake-ledger] reading L2 state from ${CAW_NAMES_L2_ADDRESS}, L1 nextId from ${CAW_NAMES_ADDRESS}...`)

  const [multiplier, totalCaw, nextId] = await Promise.all([
    l2.rewardMultiplier(),
    l2.totalCaw(),
    l1.nextId(),
  ])
  const maxId = Number(nextId) - 1
  console.log(`  rewardMultiplier = ${multiplier}`)
  console.log(`  totalCaw         = ${totalCaw}`)
  console.log(`  nextId           = ${nextId} (will read tokens 1..${maxId})`)

  if (maxId < 1) {
    console.log('  No tokens minted — only seeding StakeLedgerState.')
  }

  // Read all token ownerships in batches. A multicall would be faster
  // but adds a dep; for the seed-once case the simple Promise.all
  // chunking is fine. Most testnet chains have <10k tokens.
  const ownership = new Map<number, bigint>()
  const BATCH = 50
  for (let start = 1; start <= maxId; start += BATCH) {
    const end = Math.min(start + BATCH - 1, maxId)
    const ids = Array.from({ length: end - start + 1 }, (_, i) => start + i)
    const reads = await Promise.all(ids.map(async id => {
      try {
        const v = await l2.cawOwnership(id)
        return { id, v: BigInt(v) }
      } catch (err: any) {
        // Skip burned / non-existent slots quietly; they shouldn't appear
        // mid-range in the current contract design but be defensive.
        return { id, v: null as bigint | null }
      }
    }))
    for (const r of reads) {
      if (r.v !== null && r.v !== 0n) ownership.set(r.id, r.v)
    }
    process.stdout.write(`\r  read ${end}/${maxId} (${ownership.size} non-zero owners so far)…`)
  }
  if (maxId >= 1) process.stdout.write('\n')

  const sumOwnership = [...ownership.values()].reduce((a, b) => a + b, 0n)
  console.log(`  sum(cawOwnership) = ${sumOwnership}`)
  if (sumOwnership !== BigInt(totalCaw)) {
    // Not fatal — sum can lag totalCaw by one block during reads, or
    // contract may not enforce strict equality at all times. Log so the
    // operator can decide whether to retry.
    console.warn(`  ⚠  sum != totalCaw (delta ${BigInt(totalCaw) - sumOwnership}). Re-running with stable head usually closes this.`)
  }

  if (dryRun) {
    console.log('[seed-stake-ledger] dry run — no DB writes.')
    return
  }

  // StakeLedgerState upsert. lastBlock=0, lastLogIndex=-1 so the
  // indexer's resume-cursor in recordAction() doesn't skip anything.
  // The first observed ActionsProcessed event applies normally — the
  // multiplier we just seeded is the chain's *current* value; the
  // ledger's per-event check will pass.
  await prisma.stakeLedgerState.upsert({
    where: { clientId },
    create: {
      clientId,
      multiplier: String(multiplier),
      totalCaw: String(totalCaw),
      lastBlock: 0n,
      lastLogIndex: -1,
    },
    update: {
      multiplier: String(multiplier),
      totalCaw: String(totalCaw),
    },
  })
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

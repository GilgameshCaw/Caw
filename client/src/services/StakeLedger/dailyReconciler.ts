// Daily per-active-user reconciler. Reads cawOwnership(tokenId) from
// L2 for every user that was a sender, recipient, or otherwise touched
// in the last 24h, and asserts equality with our CawOwnershipCurrent
// snapshot. The per-event multiplier checksum in the snapshotter
// catches drift propagated through the multiplier chain; this is the
// safety net for the corner case of a user whose ownership drifted
// but who hasn't been an action participant since.
//
// Bonus duty: discovers L1->L2 deposits. When the daily read shows
// chain ownership higher than ours (and our cached value cannot
// reasonably have decreased through any path we missed), the diff is
// a deposit. We write a CawOwnershipSnapshot{reason:'DEPOSIT'} row
// and update CawOwnershipCurrent so the activity page reflects it.
// Imprecise on timing (we can only attribute "sometime in the last
// 24h"), but the chart is a daily-bucket view anyway.

import { prisma } from '../../prismaClient'
import { getCawProfileLedger } from './cawProfileLedger'

const ONE_DAY_MS = 24 * 60 * 60 * 1000

interface ReconcileResult {
  checked: number
  matched: number
  mismatched: number
  depositsDiscovered: number
  totalDepositAmount: bigint
}

export async function runDailyReconciliation(): Promise<ReconcileResult> {
  const since = new Date(Date.now() - ONE_DAY_MS)
  // Distinct active tokenIds from yesterday's ledger activity.
  const activeRows = await prisma.cawOwnershipSnapshot.findMany({
    where: { blockTimestamp: { gte: since } },
    select: { tokenId: true },
    distinct: ['tokenId'],
  })
  const tokenIds = activeRows.map(r => r.tokenId)
  if (tokenIds.length === 0) {
    return { checked: 0, matched: 0, mismatched: 0, depositsDiscovered: 0, totalDepositAmount: 0n }
  }

  let contract
  try {
    contract = getCawProfileLedger()
  } catch (err: any) {
    console.error('[StakeLedger] Reconciler: cannot get L2 contract:', err?.message ?? err)
    return { checked: 0, matched: 0, mismatched: 0, depositsDiscovered: 0, totalDepositAmount: 0n }
  }

  const result: ReconcileResult = {
    checked: 0,
    matched: 0,
    mismatched: 0,
    depositsDiscovered: 0,
    totalDepositAmount: 0n,
  }

  // Sequential rather than parallel — RPC providers throttle hard, and
  // the active-user set in v1 is small. If this becomes slow we can
  // chunk into Promise.all batches of ~10.
  for (const tokenId of tokenIds) {
    result.checked++
    let onChain: bigint
    try {
      onChain = BigInt(await contract.cawOwnership(tokenId))
    } catch (err: any) {
      console.warn(`[StakeLedger] Reconciler: tokenId=${tokenId} read failed: ${err?.message ?? err}`)
      continue
    }

    const currentRow = await prisma.cawOwnershipCurrent.findUnique({ where: { tokenId } })
    const cached = currentRow ? BigInt(currentRow.ownership) : 0n

    if (onChain === cached) {
      result.matched++
      continue
    }

    if (onChain > cached) {
      // Likely a deposit (no other path inflates ownership without an
      // Action that we'd have ledgered). Write a DEPOSIT row at NOW
      // (best timing we can offer — true block timestamp is unknown
      // without scanning LZ deposit events) and update the cache.
      const diff = onChain - cached
      // We don't know the multiplier at deposit time precisely; for the
      // delta column we record the diff in ownership-space directly,
      // and the balance/multiplier columns reflect the post-deposit
      // state. Acceptable: the chart consumer reads `delta` (in CAW
      // wei) and we approximate that as ownership_diff × current
      // multiplier / 1e18 — which is what the user actually sees
      // because the multiplier in effect during display is the same.
      const stateRow = await prisma.stakeLedgerState.findFirst()
      const multiplier = stateRow ? BigInt(stateRow.multiplier) : 10n ** 18n
      const balanceDelta = (diff * multiplier) / (10n ** 18n)
      const balance = (onChain * multiplier) / (10n ** 18n)
      const now = new Date()

      await prisma.$transaction(async (tx) => {
        await tx.cawOwnershipSnapshot.create({
          data: {
            tokenId,
            blockNumber: 0n,
            blockTimestamp: now,
            txHash: 'reconciler-discovered',
            logIndex: 0,
            actionIndex: null,
            ownership: onChain.toString(),
            multiplier: multiplier.toString(),
            balance: balance.toString(),
            delta: balanceDelta.toString(),
            reason: 'DEPOSIT',
            actionType: null,
            counterpartyTokenId: null,
          },
        })
        await tx.cawOwnershipCurrent.upsert({
          where: { tokenId },
          create: { tokenId, ownership: onChain.toString() },
          update: { ownership: onChain.toString(), updatedAt: now },
        })
      })

      result.depositsDiscovered++
      result.totalDepositAmount += balanceDelta
      console.log(`[StakeLedger] Reconciler: discovered deposit for tokenId=${tokenId} (~${balanceDelta} wei)`)
      continue
    }

    // onChain < cached: real divergence. Cache says the user has more
    // CAW than the contract does. This is a bug — log loudly and do
    // NOT auto-correct (we'd be hiding the drift the operator should
    // investigate).
    result.mismatched++
    console.error(
      `[StakeLedger] Reconciler MISMATCH: tokenId=${tokenId} chain=${onChain} cached=${cached}. ` +
        `Ledger over-counted this user. Investigate before reseeding.`,
    )
  }

  console.log(
    `[StakeLedger] Reconciler done: checked=${result.checked} matched=${result.matched} ` +
      `mismatched=${result.mismatched} deposits=${result.depositsDiscovered} ` +
      `(total ~${result.totalDepositAmount} wei)`,
  )
  return result
}

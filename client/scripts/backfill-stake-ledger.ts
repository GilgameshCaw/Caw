// scripts/backfill-stake-ledger.ts
//
// Backfill historical CAW activity rows from the Action + RawEvent
// tables, plus seed snapshotter state from on-chain (cawOwnership[*],
// multiplier, totalCaw). Going forward, the live snapshotter takes
// over and produces exact ledger rows including communal income.
//
// Why we DON'T full-replay from RawEvent with contract math: L1->L2
// deposits don't surface as RawEvents (they hit
// CawProfileL2._lzReceive directly). Without a deposit ledger,
// totalCaw at any historical timestamp is unknown. Multiplier
// inflation depends on totalCaw, so any attempt to recompute
// multiplier history compounds errors. An earlier "infer deposits
// when sender runs short" attempt diverged ~300× from chain — not
// safe.
//
// What we DO instead:
//   1. Walk every RawEvent for CAW_ACTIONS_ADDRESS in chronological
//      order. For each action, write a CawOwnershipSnapshot row per
//      touched user (sender + recipient + validator), tagged with
//      the right reason. Deltas come from the static cost map and
//      the action's amounts[]/recipients[]. The `ownership`,
//      `multiplier`, `balance` columns are written as 0 — we don't
//      know historical values and don't pretend to. The chart only
//      reads `delta`, `reason`, `actionType`, `blockTimestamp`, so
//      this is enough.
//   2. Read on-chain (multiplier, totalCaw) and cawOwnership[*] for
//      every known user. Seed StakeLedgerState + CawOwnershipCurrent.
//      Set lastBlock to current chain head so the live snapshotter
//      doesn't re-replay backlog when it boots.
//
// After this, the activity page shows historical direct activity AND
// new actions accrue real communal income. Old days show
// communalEarned=0 because we can't reconstruct it. UI tooltip
// disclaims this.
//
// Idempotent. --reset wipes the ledger tables first.
//
// Usage:
//   npx tsx scripts/backfill-stake-ledger.ts [--reset]

import { prisma } from '../src/prismaClient'
import { CAW_ACTIONS_ADDRESS } from '../src/abi/addresses'
import { ACTION_TYPE_NUM_TO_NAME, ACTION_COST, type FixedCostActionType } from '../src/utils/cawActionCosts'
import { PRECISION } from '../src/services/StakeLedger/contractMath'
import { getCawProfileL2 } from '../src/services/StakeLedger/cawProfileL2'

const args = new Set(process.argv.slice(2))
const RESET = args.has('--reset')

const CAW_CLIENT_ID = (() => {
  const raw = process.env.CLIENT_ID
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('CLIENT_ID is required (set it in client/.env)')
  }
  return n
})()

interface RawAction {
  actionType: number | string
  senderId: number | string
  receiverId?: number | string
  receiverCawonce?: number | string
  cawonce: number | string
  text?: string
  recipients?: (number | string)[]
  amounts?: (string | number | bigint)[]
}

function logProgress(msg: string) {
  console.log(`[backfill] ${msg}`)
}

async function preflight() {
  const existing = await prisma.cawOwnershipSnapshot.count()
  if (existing > 0 && !RESET) {
    console.error(
      `[backfill] Refusing to run: ${existing} CawOwnershipSnapshot rows already exist. ` +
        `Re-run with --reset to wipe and start clean.`,
    )
    process.exit(1)
  }
  if (RESET) {
    logProgress('Resetting ledger tables…')
    await prisma.$transaction(async (tx) => {
      await tx.cawOwnershipSnapshot.deleteMany()
      await tx.rewardMultiplierSnapshot.deleteMany()
      await tx.cawOwnershipCurrent.deleteMany()
      await tx.stakeLedgerState.deleteMany({ where: { clientId: CAW_CLIENT_ID } })
    })
  }
}

type TouchReason =
  | 'ACTION_SPEND_BASE'
  | 'ACTION_SPEND_TIP'
  | 'ACTION_SPEND_VALIDATOR_TIP'
  | 'ACTION_RECIPIENT'
  | 'ACTION_VALIDATOR'

interface Touch {
  tokenId: number
  delta: bigint                  // signed wei
  reason: TouchReason
  counterpartyTokenId: number | null
}

interface ActionTouches {
  displayActionType: string | null
  touches: Touch[]
}

/**
 * Compute per-touch wei deltas for a single action — one row per
 * component (sender's base spend, sender's tip spend, sender's
 * validator-tip spend, recipient credit, validator credit). Mirrors
 * the live snapshotter's row model so the chart can stack incoming
 * and outgoing independently.
 */
function deltasForAction(rawAction: RawAction, validatorId: number): ActionTouches {
  const rawTypeName = ACTION_TYPE_NUM_TO_NAME[Number(rawAction.actionType) as keyof typeof ACTION_TYPE_NUM_TO_NAME]
  const isOtherTip = rawTypeName === 'OTHER' && typeof rawAction.text === 'string' && rawAction.text.startsWith('tip:')
  const displayActionType = isOtherTip ? 'TIP' : (rawTypeName ?? null)
  const senderId = Number(rawAction.senderId)
  const receiverId = rawAction.receiverId ? Number(rawAction.receiverId) : 0

  const touches: Touch[] = []

  // Step 1: type-specific cost. Sender pays the base, recipient gets
  // their direct credit (LIKE/RECAW/FOLLOW only).
  if (rawTypeName === 'CAW' || rawTypeName === 'LIKE' || rawTypeName === 'RECAW' || rawTypeName === 'FOLLOW') {
    const cost = ACTION_COST[rawTypeName as FixedCostActionType]
    touches.push({
      tokenId: senderId,
      delta: -(cost.spend * PRECISION),
      reason: 'ACTION_SPEND_BASE',
      counterpartyTokenId: receiverId || null,
    })
    if (cost.receive > 0n && receiverId !== 0) {
      touches.push({
        tokenId: receiverId,
        delta: cost.receive * PRECISION,
        reason: 'ACTION_RECIPIENT',
        counterpartyTokenId: senderId,
      })
    }
  } else if (rawTypeName === 'WITHDRAW') {
    const amount = BigInt(rawAction.amounts?.[0] ?? 0) * PRECISION
    touches.push({
      tokenId: senderId,
      delta: -amount,
      reason: 'ACTION_SPEND_BASE',
      counterpartyTokenId: null,
    })
  }

  // Step 2: distributeAmountsMem.
  const amounts = rawAction.amounts ?? []
  const recipients = rawAction.recipients ?? []
  if (amounts.length > 0) {
    const numAmounts = amounts.length
    const numRecipients = recipients.length
    const isWithdraw = rawTypeName === 'WITHDRAW'
    const startIndex = isWithdraw ? 1 : 0

    let recipientPortion = 0n
    for (let i = startIndex; i < numRecipients; i++) {
      const recipientTokenId = Number(recipients[i])
      const amountWei = BigInt(amounts[i] ?? 0) * PRECISION
      touches.push({
        tokenId: recipientTokenId,
        delta: amountWei,
        reason: 'ACTION_RECIPIENT',
        counterpartyTokenId: senderId,
      })
      recipientPortion += amountWei
    }
    const validatorTipWei = BigInt(amounts[numAmounts - 1] ?? 0) * PRECISION

    // Sender's outgoing legs split into tip-portion vs validator-fee
    // so the outgoing-spend chart can stack them as distinct segments.
    if (recipientPortion > 0n) {
      touches.push({
        tokenId: senderId,
        delta: -recipientPortion,
        reason: 'ACTION_SPEND_TIP',
        counterpartyTokenId: receiverId || (numRecipients > 0 ? Number(recipients[0]) : null),
      })
    }
    if (validatorTipWei > 0n) {
      touches.push({
        tokenId: senderId,
        delta: -validatorTipWei,
        reason: 'ACTION_SPEND_VALIDATOR_TIP',
        counterpartyTokenId: validatorId || null,
      })
      if (validatorId > 0) {
        touches.push({
          tokenId: validatorId,
          delta: validatorTipWei,
          reason: 'ACTION_VALIDATOR',
          counterpartyTokenId: senderId,
        })
      }
    }
  }

  return { displayActionType, touches }
}

async function backfillRows() {
  let cursorId = 0
  const PAGE = 500
  let totalActions = 0
  let totalRows = 0
  const startedAt = Date.now()

  for (;;) {
    const rows = await prisma.rawEvent.findMany({
      where: { id: { gt: cursorId }, contractAddress: CAW_ACTIONS_ADDRESS },
      orderBy: { id: 'asc' },
      take: PAGE,
    })
    if (rows.length === 0) break

    for (const raw of rows) {
      cursorId = raw.id
      const topics = Array.isArray(raw.topics) ? (raw.topics as any[]) : []
      let validatorId = 0
      if (topics[2]) { try { validatorId = Number(BigInt(String(topics[2]))) } catch {} }

      const list: RawAction[] = Array.isArray(raw.data) ? (raw.data as any) : [raw.data as any]
      let actionIndex = 0
      const allRows: any[] = []
      for (const rawAction of list) {
        const { displayActionType, touches } = deltasForAction(rawAction, validatorId)
        for (const t of touches) {
          if (t.delta === 0n) continue
          allRows.push({
            tokenId: t.tokenId,
            blockNumber: raw.blockNumber,
            blockTimestamp: raw.createdAt,
            txHash: raw.transactionHash,
            logIndex: raw.logIndex,
            actionIndex,
            // Historical multiplier/ownership/balance unknown; chart
            // doesn't read these for direct activity. Set zeros.
            ownership: '0',
            multiplier: '0',
            balance: '0',
            delta: t.delta.toString(),
            reason: t.reason,
            actionType: displayActionType,
            counterpartyTokenId: t.counterpartyTokenId,
          })
        }
        actionIndex++
        totalActions++
      }
      if (allRows.length > 0) {
        await prisma.cawOwnershipSnapshot.createMany({ data: allRows })
        totalRows += allRows.length
      }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    logProgress(`processed ${totalActions} actions, wrote ${totalRows} rows — ${elapsed}s`)
  }

  return { totalActions, totalRows }
}

async function seedFromChain() {
  logProgress('Seeding state from chain…')
  let contract
  try {
    contract = getCawProfileL2()
  } catch (err: any) {
    console.error(`[backfill] No L2 RPC configured (${err?.message ?? err}). Skipping chain seed; live snapshotter will start from genesis assumptions and the per-event multiplier check will halt on first action.`)
    return
  }

  let multiplier: bigint
  let totalCaw: bigint
  let lastBlock: bigint
  try {
    multiplier = BigInt(await contract.rewardMultiplier())
    totalCaw = BigInt(await contract.totalCaw())
    lastBlock = BigInt(await contract.runner!.provider!.getBlockNumber())
  } catch (err: any) {
    console.error(`[backfill] Failed to read chain state: ${err?.message ?? err}. Skipping chain seed.`)
    return
  }
  logProgress(`chain multiplier=${multiplier} totalCaw=${totalCaw} block=${lastBlock}`)

  const users = await prisma.user.findMany({ select: { tokenId: true } })
  let read = 0
  for (const u of users) {
    let chainOwn: bigint
    try {
      chainOwn = BigInt(await contract.cawOwnership(u.tokenId))
    } catch (err: any) {
      console.warn(`  tokenId=${u.tokenId}: read failed (${err?.message ?? err})`)
      continue
    }
    await prisma.cawOwnershipCurrent.upsert({
      where: { tokenId: u.tokenId },
      create: { tokenId: u.tokenId, ownership: chainOwn.toString() },
      update: { ownership: chainOwn.toString(), updatedAt: new Date() },
    })
    read++
    if (read % 50 === 0) logProgress(`  ${read}/${users.length} users seeded`)
  }
  logProgress(`seeded ownership for ${read}/${users.length} users`)

  await prisma.stakeLedgerState.upsert({
    where: { clientId: CAW_CLIENT_ID },
    create: {
      clientId: CAW_CLIENT_ID,
      totalCaw: totalCaw.toString(),
      multiplier: multiplier.toString(),
      lastBlock,
      lastLogIndex: 1_000_000_000, // skip any log on the seed block
    },
    update: {
      totalCaw: totalCaw.toString(),
      multiplier: multiplier.toString(),
      lastBlock,
      lastLogIndex: 1_000_000_000,
      updatedAt: new Date(),
    },
  })
}

async function main() {
  await preflight()
  const stats = await backfillRows()
  await seedFromChain()
  logProgress(`Done. ${stats.totalActions} actions processed, ${stats.totalRows} ledger rows written.`)
  await prisma.$disconnect()
  process.exit(0)
}

main().catch(err => {
  console.error('[backfill] FAILED:', err)
  process.exit(1)
})

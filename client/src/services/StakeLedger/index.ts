// StakeLedger snapshotter — mirrors CawProfileL2 state transitions in
// TypeScript bigint, writing per-user delta rows and per-multiplier-
// change rows. Hot path makes zero RPC reads. After each
// ActionsProcessed event finishes its actions, the caller invokes
// verifyMultiplier() which reads chain rewardMultiplier() once and
// asserts equality with our running value — divergence halts writes
// and logs loud. A separate daily reconciler (dailyReconciler.ts)
// catches per-user drift that the multiplier check can't witness.
//
// Sequence per action mirrors CawActions._applyAction
// (`solidity/contracts/CawActions.sol:619`):
//   1. Type-specific step (CAW/LIKE/RECAW/FOLLOW/WITHDRAW). Updates
//      sender ownership + multiplier + recipient ownership.
//   2. _distributeAmountsMem if amounts.length > 0. Per-recipient
//      addToBalance, then sender pays totalAmount with 0 communal,
//      then validator gets a tip via addToBalance.
//
// Per-user touches in step 1 + step 2 collapse into one
// CawOwnershipSnapshot row per user per action — sender's row aggregates
// every debit, recipient gets one row, validator gets one row.

import { prisma } from '../../prismaClient'
import type { PrismaTransactionClient, RawAction } from '../ActionProcessor/types'
import {
  ACTION_COST,
  ACTION_TYPE_NUM_TO_NAME,
  type FixedCostActionType,
} from '../../utils/cawActionCosts'
import {
  PRECISION,
  balanceOf,
  ownershipFromBalance,
  spendAndDistribute,
  addToBalance,
} from './contractMath'
import { getCawProfileL2 as _getCawProfileL2Real } from './cawProfileL2'
import { getNetworkId } from '../../utils/networkId'

// Tests can override this to avoid real RPC calls.
// eslint-disable-next-line prefer-const
let _cawProfileL2Override: { rewardMultiplier: (...args: any[]) => Promise<any> } | null = null

function getCawProfileL2(): { rewardMultiplier: (...args: any[]) => Promise<any> } {
  return (_cawProfileL2Override ?? _getCawProfileL2Real()) as any
}

// One client per process — the snapshotter reads CLIENT_ID from env at
// boot and persists state under that key.
const CAW_CLIENT_ID = (() => {
  const raw = getNetworkId()
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('StakeLedger: NETWORK_ID is required (set it in client/.env)')
  }
  return n
})()

export interface RuntimeState {
  multiplier: bigint
  totalCaw: bigint
  // Cached cawOwnership[tokenId]. Loaded lazily — on first touch we read
  // from CawOwnershipCurrent (or assume 0n for never-seen tokens).
  ownership: Map<number, bigint>
  // Block + log we've consumed up to. Used to skip already-processed
  // actions on warm restart.
  lastBlock: bigint
  lastLogIndex: number
  // Halts writes after a multiplier-checksum mismatch. Cleared by the
  // operator once they reseed.
  halted: boolean
}

let state: RuntimeState | null = null
let bootPromise: Promise<RuntimeState> | null = null

/**
 * Idempotent boot. Loads StakeLedgerState + CawOwnershipCurrent into
 * memory. If StakeLedgerState is missing, seeds (multiplier=1e18,
 * totalCaw=0) — the first observed actions will populate.
 *
 * Call this at process start before recording any actions. ActionProcessor
 * already serialises action handling, so racing boots are not a concern.
 */
export async function ensureBooted(): Promise<RuntimeState> {
  if (state) return state
  if (bootPromise) return bootPromise
  bootPromise = (async () => {
    const persisted = await prisma.stakeLedgerState.findUnique({ where: { networkId: CAW_CLIENT_ID } })
    const ownership = new Map<number, bigint>()
    const currentRows = await prisma.cawOwnershipCurrent.findMany()
    for (const row of currentRows) ownership.set(row.tokenId, BigInt(row.ownership))
    const next: RuntimeState = persisted
      ? {
          multiplier: BigInt(persisted.multiplier),
          totalCaw: BigInt(persisted.totalCaw),
          ownership,
          lastBlock: BigInt(persisted.lastBlock),
          lastLogIndex: persisted.lastLogIndex,
          halted: false,
        }
      : {
          multiplier: PRECISION,
          totalCaw: 0n,
          ownership,
          lastBlock: 0n,
          lastLogIndex: -1,
          halted: false,
        }
    state = next
    return next
  })()
  return bootPromise
}

/**
 * Returns the user's cached ownership, defaulting to 0n for unseen
 * tokens. Always synchronous against the in-memory cache — callers
 * must have called ensureBooted() first.
 */
function ownershipOf(s: RuntimeState, tokenId: number): bigint {
  return s.ownership.get(tokenId) ?? 0n
}

interface RecordParams {
  rawAction: RawAction
  validatorId: number
  blockNumber: bigint
  blockTimestamp: Date
  txHash: string
  logIndex: number
  actionIndex: number
}

/**
 * Apply one action to running state and write ledger rows. Mirrors
 * CawActions._applyAction step-by-step. Idempotent on
 * (blockNumber, logIndex, actionIndex) — re-running the same action is
 * a no-op (the (blockNumber, logIndex, actionIndex) primary key on
 * RewardMultiplierSnapshot would conflict, and we skip CawOwnershipSnapshot
 * inserts that would duplicate the same key shape).
 *
 * Run inside the same Prisma $transaction the caller is using for
 * domain effects. The math is pure bigint; the only DB I/O is the
 * row inserts and a final state-update.
 */
export async function recordAction(
  tx: PrismaTransactionClient,
  params: RecordParams,
): Promise<void> {
  const s = await ensureBooted()
  if (s.halted) return // Operator must reseed before we resume.

  // Skip already-processed actions on warm restart. ActionProcessor
  // resumes from lastId; we resume from (lastBlock, lastLogIndex).
  if (
    params.blockNumber < s.lastBlock ||
    (params.blockNumber === s.lastBlock && params.logIndex <= s.lastLogIndex)
  ) {
    return
  }

  const { rawAction, validatorId, blockNumber, blockTimestamp, txHash, logIndex, actionIndex } = params
  const senderId = Number(rawAction.senderId)
  const receiverId = rawAction.receiverId ? Number(rawAction.receiverId) : 0
  const rawTypeName = ACTION_TYPE_NUM_TO_NAME[Number(rawAction.actionType) as keyof typeof ACTION_TYPE_NUM_TO_NAME]
  // Resolve OTHER:tip into a TIP actionType so the chart can stack tips
  // separately from the catch-all OTHER bucket. Other OTHER subtypes
  // (poll vote, hide, etc.) stay as OTHER.
  const isOtherTip = rawTypeName === 'OTHER' && typeof rawAction.text === 'string' && rawAction.text.startsWith('tip:')
  const displayActionType = isOtherTip ? 'TIP' : rawTypeName

  // One row per individual touch component. Distinct from the previous
  // model (one row per touched user) so the chart can stack by reason
  // independently for incoming and outgoing.
  type TouchReason =
    | 'ACTION_SPEND_BASE'           // sender pays the type-specific cost
    | 'ACTION_SPEND_TIP'            // sender pays a tip to another user (OTHER:tip)
    | 'ACTION_SPEND_VALIDATOR_TIP'  // sender pays the validator fee (every action)
    | 'ACTION_RECIPIENT'            // user received a type credit or a tip
    | 'ACTION_VALIDATOR'            // user received a validator-fee credit
  interface TouchRow {
    tokenId: number
    delta: bigint
    finalOwnership: bigint
    finalBalance: bigint
    reason: TouchReason
    counterpartyTokenId: number | null
  }
  const touches: TouchRow[] = []
  const pushTouch = (
    tokenId: number,
    delta: bigint,
    finalOwnership: bigint,
    finalBalance: bigint,
    reason: TouchReason,
    counterpartyTokenId: number | null,
  ) => {
    touches.push({ tokenId, delta, finalOwnership, finalBalance, reason, counterpartyTokenId })
  }

  // RewardMultiplierSnapshot writes accumulate here so we can batch them
  // into a single createMany after step 2.
  const multiplierEvents: Array<{ before: bigint; after: bigint; communal: bigint; subActionIndex: number }> = []
  let subActionIndex = 0

  // -------------------------
  // STEP 1: type-specific
  // -------------------------
  if (
    rawTypeName === 'CAW' ||
    rawTypeName === 'LIKE' ||
    rawTypeName === 'RECAW' ||
    rawTypeName === 'FOLLOW'
  ) {
    const cost = ACTION_COST[rawTypeName as FixedCostActionType]
    const senderOwn = ownershipOf(s, senderId)
    const senderBalBefore = balanceOf(senderOwn, s.multiplier)
    const r = spendAndDistribute(senderOwn, s, cost.spend * PRECISION, cost.communal * PRECISION)
    if (r.communalDistributed > 0n) {
      multiplierEvents.push({
        before: s.multiplier,
        after: r.multiplier,
        communal: r.communalDistributed,
        subActionIndex: subActionIndex++,
      })
    }
    s.multiplier = r.multiplier
    s.ownership.set(senderId, r.senderOwnership)
    pushTouch(
      senderId,
      r.senderBalance - senderBalBefore, // negative
      r.senderOwnership,
      r.senderBalance,
      'ACTION_SPEND_BASE',
      receiverId || null,
    )

    if (cost.receive > 0n && receiverId !== 0) {
      const recvOwn = ownershipOf(s, receiverId)
      const recvBalBefore = balanceOf(recvOwn, s.multiplier)
      const recv = addToBalance(recvOwn, s.multiplier, cost.receive * PRECISION)
      s.ownership.set(receiverId, recv.ownership)
      pushTouch(
        receiverId,
        recv.balance - recvBalBefore,
        recv.ownership,
        recv.balance,
        'ACTION_RECIPIENT',
        senderId,
      )
    }
  } else if (rawTypeName === 'WITHDRAW') {
    // CawProfileL2.withdraw(): debits sender, decrements totalCaw.
    // Modelled as ACTION_SPEND_BASE so the chart's outgoing stack
    // surfaces it the same way as other type-specific costs.
    const amount = (BigInt(rawAction.amounts?.[0] ?? 0)) * PRECISION
    const senderOwn = ownershipOf(s, senderId)
    const senderBal = balanceOf(senderOwn, s.multiplier)
    if (senderBal < amount) {
      console.error(`[StakeLedger] WITHDRAW: insufficient balance — ledger drift? sender=${senderId} bal=${senderBal} amt=${amount}`)
      s.halted = true
      return
    }
    const newBal = senderBal - amount
    const newOwn = ownershipFromBalance(newBal, s.multiplier)
    s.ownership.set(senderId, newOwn)
    s.totalCaw -= amount
    pushTouch(senderId, -amount, newOwn, newBal, 'ACTION_SPEND_BASE', null)
  }
  // UNLIKE / UNFOLLOW / OTHER (excluding tip side effects via amounts):
  // no type-specific contract action. Step 2 handles validator tip/recipients.

  // OTHER:tip — sender pays the recipient + validator tip via step 2;
  // we re-tag the spend rows below with reason=ACTION_SPEND_TIP so the
  // outgoing chart segments out tips from base costs.

  // -------------------------
  // STEP 2: _distributeAmountsMem
  // -------------------------
  const amounts = rawAction.amounts ?? []
  const recipients = rawAction.recipients ?? []
  if (amounts.length > 0) {
    const numAmounts = amounts.length
    const numRecipients = recipients.length
    const isWithdraw = rawTypeName === 'WITHDRAW'
    const startIndex = isWithdraw ? 1 : 0

    // Per-recipient addToBalance — these are the tip-recipient credits
    // for OTHER:tip, or extra-recipient payouts on other action types.
    let amountTotal = 0n
    for (let i = startIndex; i < numRecipients; i++) {
      const recipientTokenId = Number(recipients[i])
      const amountWei = BigInt(amounts[i] ?? 0) * PRECISION
      const recvOwn = ownershipOf(s, recipientTokenId)
      const recvBalBefore = balanceOf(recvOwn, s.multiplier)
      const recv = addToBalance(recvOwn, s.multiplier, amountWei)
      s.ownership.set(recipientTokenId, recv.ownership)
      pushTouch(
        recipientTokenId,
        recv.balance - recvBalBefore,
        recv.ownership,
        recv.balance,
        'ACTION_RECIPIENT',
        senderId,
      )
      amountTotal += amountWei
    }
    // Validator tip is the LAST element of `amounts`. Always counted in
    // amountTotal so the spender pays it, even on withdrawals.
    const validatorTipWei = BigInt(amounts[numAmounts - 1] ?? 0) * PRECISION
    amountTotal += validatorTipWei

    // Sender pays amountTotal with 0 communal. Split into two rows:
    // one for the tip portion (recipients), one for the validator-tip
    // portion. This is what makes the outgoing chart legend usable.
    const recipientPortion = amountTotal - validatorTipWei
    if (amountTotal > 0n) {
      const senderOwn = ownershipOf(s, senderId)
      const senderBalBefore = balanceOf(senderOwn, s.multiplier)
      const r = spendAndDistribute(senderOwn, s, amountTotal, 0n)
      s.multiplier = r.multiplier // unchanged but assign for clarity
      s.ownership.set(senderId, r.senderOwnership)
      // recipientPortion: tagged ACTION_SPEND_TIP (the user's outgoing
      // tip spend). For non-tip actions this segment is normally 0;
      // it shows up only when amounts has a payee beyond the validator.
      if (recipientPortion > 0n) {
        // Synthesize an intermediate balance for this row (the actual
        // post-recipient-portion balance). The contract did one
        // spendAndDistribute call; we split the row but recompute the
        // intermediate balance for accurate per-row final-balance.
        const balAfterRecipient = senderBalBefore - recipientPortion
        const ownAfterRecipient = ownershipFromBalance(balAfterRecipient, s.multiplier)
        pushTouch(
          senderId,
          -recipientPortion,
          ownAfterRecipient,
          balAfterRecipient,
          'ACTION_SPEND_TIP',
          // Tip target: prefer the receiverId from the action header
          // (used by tip:userId:cawonce text protocol) and fall back to
          // the first recipient in amounts[].
          receiverId || (numRecipients > 0 ? Number(recipients[0]) : null),
        )
      }
      if (validatorTipWei > 0n) {
        // Validator tip from the sender's perspective. Distinct reason
        // so the outgoing-spend chart can stack "Validator fees" as its
        // own segment.
        pushTouch(
          senderId,
          -validatorTipWei,
          r.senderOwnership,
          r.senderBalance,
          'ACTION_SPEND_VALIDATOR_TIP',
          validatorId || null,
        )
      }
    }

    // Validator receives the tip via addToBalance.
    if (validatorTipWei > 0n) {
      const valOwn = ownershipOf(s, validatorId)
      const valBalBefore = balanceOf(valOwn, s.multiplier)
      const val = addToBalance(valOwn, s.multiplier, validatorTipWei)
      s.ownership.set(validatorId, val.ownership)
      pushTouch(
        validatorId,
        val.balance - valBalBefore,
        val.ownership,
        val.balance,
        'ACTION_VALIDATOR',
        senderId,
      )
    }
  }

  // -------------------------
  // PERSIST
  // -------------------------
  if (multiplierEvents.length > 0) {
    await tx.rewardMultiplierSnapshot.createMany({
      data: multiplierEvents.map(e => ({
        blockNumber,
        txHash,
        logIndex,
        actionIndex: actionIndex * 16 + e.subActionIndex, // unique per sub-step within this action
        blockTimestamp,
        multiplierBefore: e.before.toString(),
        multiplierAfter: e.after.toString(),
        communalAmount: e.communal.toString(),
        actionType: displayActionType,
      })),
      skipDuplicates: true,
    })
  }

  if (touches.length > 0) {
    await tx.cawOwnershipSnapshot.createMany({
      data: touches.map(t => ({
        tokenId: t.tokenId,
        blockNumber,
        blockTimestamp,
        txHash,
        logIndex,
        actionIndex,
        ownership: t.finalOwnership.toString(),
        multiplier: s.multiplier.toString(),
        balance: t.finalBalance.toString(),
        delta: t.delta.toString(),
        reason: t.reason,
        actionType: displayActionType,
        counterpartyTokenId: t.counterpartyTokenId,
      })),
    })

    // CawOwnershipCurrent mirrors the latest cawOwnership[tokenId] for
    // the daily reconciler. Multiple touches for the same user in one
    // action collapse into one upsert per tokenId, taking the LAST
    // recorded ownership (which is the post-action contract state).
    //
    // Sequential, not Promise.all: each upsert needs its own connection
    // from the Prisma pool. A single action can touch 3+ tokens (sender,
    // receiver, validator, tip recipients) — fanning those out in
    // parallel saturates the pool when multiple ActionProcessor handlers
    // run concurrently, and the 15s tx timeout fires before any of them
    // get their connection. Sequential keeps the per-tx connection
    // footprint at 1 (held by the outer tx itself).
    const finalByToken = new Map<number, bigint>()
    for (const t of touches) finalByToken.set(t.tokenId, t.finalOwnership)
    for (const [tokenId, ownership] of finalByToken) {
      await tx.cawOwnershipCurrent.upsert({
        where: { tokenId },
        create: { tokenId, ownership: ownership.toString() },
        update: { ownership: ownership.toString(), updatedAt: new Date() },
      })
    }
  }

  s.lastBlock = blockNumber
  s.lastLogIndex = logIndex
  await tx.stakeLedgerState.upsert({
    where: { networkId: CAW_CLIENT_ID },
    create: {
      networkId: CAW_CLIENT_ID,
      totalCaw: s.totalCaw.toString(),
      multiplier: s.multiplier.toString(),
      lastBlock: blockNumber,
      lastLogIndex: logIndex,
    },
    update: {
      totalCaw: s.totalCaw.toString(),
      multiplier: s.multiplier.toString(),
      lastBlock: blockNumber,
      lastLogIndex: logIndex,
      updatedAt: new Date(),
    },
  })
}

/**
 * Apply a confirmed L1->L2 deposit. Called from the LZ deposit
 * consumer (not from action processing). Idempotent on
 * (blockNumber, logIndex). Runs in its own transaction scope provided
 * by the caller.
 */
export async function recordDeposit(
  tx: PrismaTransactionClient,
  params: {
    tokenId: number
    amountWei: bigint
    blockNumber: bigint
    blockTimestamp: Date
    txHash: string
    logIndex: number
  },
): Promise<void> {
  const s = await ensureBooted()
  if (s.halted) return
  const { tokenId, amountWei, blockNumber, blockTimestamp, txHash, logIndex } = params

  // Dedup: a watcher restart catching up may replay the same Deposited
  // log. (txHash, logIndex) uniquely identifies the source event.
  const existing = await tx.cawOwnershipSnapshot.findFirst({
    where: { txHash, logIndex, reason: 'DEPOSIT' },
    select: { id: true },
  })
  if (existing) return

  s.totalCaw += amountWei
  const own = ownershipOf(s, tokenId)
  const startingBalance = balanceOf(own, s.multiplier)
  const after = addToBalance(own, s.multiplier, amountWei)
  s.ownership.set(tokenId, after.ownership)

  await tx.cawOwnershipSnapshot.create({
    data: {
      tokenId,
      blockNumber,
      blockTimestamp,
      txHash,
      logIndex,
      actionIndex: null,
      ownership: after.ownership.toString(),
      multiplier: s.multiplier.toString(),
      balance: after.balance.toString(),
      delta: (after.balance - startingBalance).toString(),
      reason: 'DEPOSIT',
      actionType: null,
      counterpartyTokenId: null,
    },
  })
  await tx.cawOwnershipCurrent.upsert({
    where: { tokenId },
    create: { tokenId, ownership: after.ownership.toString() },
    update: { ownership: after.ownership.toString(), updatedAt: new Date() },
  })
  await tx.stakeLedgerState.upsert({
    where: { networkId: CAW_CLIENT_ID },
    create: {
      networkId: CAW_CLIENT_ID,
      totalCaw: s.totalCaw.toString(),
      multiplier: s.multiplier.toString(),
      lastBlock: blockNumber,
      lastLogIndex: logIndex,
    },
    update: {
      totalCaw: s.totalCaw.toString(),
      multiplier: s.multiplier.toString(),
      lastBlock: blockNumber,
      lastLogIndex: logIndex,
      updatedAt: new Date(),
    },
  })
}

// Error message substrings that indicate the RPC endpoint does not retain
// historical state (non-archive node).  When we catch one of these we fall
// back to a HEAD read rather than halting the ledger.
const NON_ARCHIVE_PATTERNS = [
  'missing trie node',
  'header not found',
  'state not available',
  'block not found',
  'missing required field',
  'unknown block',
]

function isNonArchiveError(msg: string): boolean {
  const lower = msg.toLowerCase()
  return NON_ARCHIVE_PATTERNS.some(p => lower.includes(p))
}

// Emit the non-archive warning at most once per process lifetime so it
// doesn't spam logs on every ActionsProcessed event.
let _nonArchiveWarnEmitted = false

/**
 * Per-event integrity check: read rewardMultiplier() from chain AT the block
 * we have fully consumed through (s.lastBlock) and assert equality with our
 * running value. Reading at a specific historical block is deterministic —
 * chain advancement between event processing and this call can no longer
 * produce spurious DIVERGENCE.
 *
 * Edge cases:
 *  - lastBlock=0n  → skip (ledger not yet consumed any actions; both sides
 *    are PRECISION by definition).
 *  - Non-archive RPC → blockTag read fails with a "missing trie node" /
 *    "state not available" family of errors; we fall back to HEAD and emit a
 *    one-time process-level warning. The ledger is NOT halted on this path.
 *  - Other RPC errors → warn + skip (existing behaviour).
 *
 * Called from outside any DB transaction — RPC reads must not extend a Prisma
 * tx timeout.
 */
export async function verifyMultiplier(): Promise<void> {
  const s = await ensureBooted()
  if (s.halted) return

  // Nothing processed yet — both sides boot to PRECISION; nothing to verify.
  if (s.lastBlock === 0n) return

  const lastBlock = Number(s.lastBlock)
  let onChain: bigint

  // Attempt a historical read at the block we've consumed through.
  try {
    onChain = BigInt(await getCawProfileL2().rewardMultiplier({ blockTag: lastBlock }))
  } catch (histErr: any) {
    const msg: string = histErr?.message ?? String(histErr)

    if (isNonArchiveError(msg)) {
      // Non-archive RPC — fall back to HEAD but don't halt.
      if (!_nonArchiveWarnEmitted) {
        console.warn(
          '[StakeLedger] historical state read failed; falling back to HEAD comparison ' +
            '(may produce spurious DIVERGENCE under high load — configure an archive RPC to eliminate). ' +
            `Error: ${msg}`,
        )
        _nonArchiveWarnEmitted = true
      }
      try {
        onChain = BigInt(await getCawProfileL2().rewardMultiplier())
      } catch (headErr: any) {
        console.warn('[StakeLedger] verifyMultiplier HEAD fallback also failed; skipping check:', headErr?.message ?? headErr)
        return
      }
    } else {
      // Transient network / timeout error — skip, don't halt.
      console.warn('[StakeLedger] verifyMultiplier RPC read failed; skipping check:', msg)
      return
    }
  }

  if (onChain !== s.multiplier) {
    console.error(
      `[StakeLedger] DIVERGENCE: chain rewardMultiplier=${onChain}, ledger=${s.multiplier} ` +
        `(checked at block ${lastBlock}). ` +
        `Halting writes — operator must reseed (read CawProfileL2 state and overwrite StakeLedgerState + CawOwnershipCurrent).`,
    )
    s.halted = true
  }
}

/** For tests / operator tooling: read the live state. */
export function _peekState(): RuntimeState | null {
  return state
}

/** For tests / operator tooling: forcibly reset memory. Does NOT touch DB. */
export function _resetForTests(): void {
  state = null
  bootPromise = null
  _nonArchiveWarnEmitted = false
  _cawProfileL2Override = null
}

/** For tests: inject a mock contract so verifyMultiplier never hits a real RPC. */
export function _setContractForTests(mock: { rewardMultiplier: (...args: any[]) => Promise<any> } | null): void {
  _cawProfileL2Override = mock
}

/** For tests: directly inject RuntimeState, bypassing Prisma boot. */
export function _injectStateForTests(s: RuntimeState): void {
  state = s
  bootPromise = null
}

/** For tests: check whether the non-archive warn has been emitted this session. */
export function _nonArchiveWarnWasEmitted(): boolean {
  return _nonArchiveWarnEmitted
}

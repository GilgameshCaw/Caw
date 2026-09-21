// StakeLedger snapshotter — mirrors CawProfileLedger state transitions in
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
import { getCawProfileLedger as _getCawProfileLedgerReal } from './cawProfileLedger'
import { getNetworkId } from '../../utils/networkId'

// Tests can override this to avoid real RPC calls.
// eslint-disable-next-line prefer-const
let _cawProfileLedgerOverride: { rewardMultiplier: (...args: any[]) => Promise<any>; cawOwnership: (...args: any[]) => Promise<any> } | null = null

function getCawProfileLedger(): { rewardMultiplier: (...args: any[]) => Promise<any>; cawOwnership: (...args: any[]) => Promise<any> } {
  return (_cawProfileLedgerOverride ?? _getCawProfileLedgerReal()) as any
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

// ---------------------------------------------------------------------------
// Ownership loading for tokens the ledger has not seen yet
// ---------------------------------------------------------------------------
//
// recordAction() runs inside the caller's Prisma $transaction (30 s timeout)
// and RPC reads must never extend that budget (see verifyMultiplier). So the
// chain is read OUTSIDE the transaction:
//  - prefetchOwnershipForAction() seeds s.ownership for the tokens an action
//    is about to touch. ActionProcessor calls it before the transaction opens.
//  - recordAction() only reads s.ownership; a token that is still unseen reads
//    as 0n.
//  - A sender that turned out to be short (or an unseen WITHDRAW sender) is
//    queued for a refresh, but only by the callback that recordAction() returns
//    (which the caller runs after the commit), so a rolled-back or retried
//    transaction leaves nothing in the queue. flushOwnershipRefreshes() then
//    re-reads the queued tokens AT THE ACTION'S BLOCK, not at HEAD: HEAD would
//    put balances from later events into replay state. An RPC that cannot serve
//    that block fails the read and nothing is written.
// Every chain read has a hard timeout. On failure or timeout nothing is cached
// and the token stays unseen, so the next action retries.

let OWNERSHIP_FETCH_TIMEOUT_MS = 5_000
// tokenId -> the block whose state the post-transaction refresh reads. Filled only
// by the callbacks recordAction() returns (i.e. after a commit), never from inside
// the transaction.
const pendingOwnershipRefresh = new Map<number, bigint>()
let _nonArchiveRefreshWarnEmitted = false

/**
 * Read cawOwnership(tokenId). With `atBlock` the read is pinned to that block; an RPC
 * that no longer serves that block's state fails the read (the caller then writes
 * nothing). It never falls back to HEAD.
 */
async function fetchChainOwnership(tokenId: number, atBlock?: bigint): Promise<bigint | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const ledger = getCawProfileLedger()
    const call = atBlock === undefined
      ? ledger.cawOwnership(tokenId)
      : ledger.cawOwnership(tokenId, { blockTag: Number(atBlock) })
    const read = Promise.resolve(call).then((v) => BigInt(v))
    read.catch(() => {}) // the timeout may win the race; don't leave a late rejection unhandled
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`cawOwnership(${tokenId}) timed out after ${OWNERSHIP_FETCH_TIMEOUT_MS} ms`)),
        OWNERSHIP_FETCH_TIMEOUT_MS,
      )
    })
    return await Promise.race([read, timeout])
  } catch (err: any) {
    const msg: string = err?.message ?? String(err)
    if (atBlock !== undefined && isNonArchiveError(msg)) {
      // Expected while catching up on a non-archive RPC: warn once, not per token.
      if (!_nonArchiveRefreshWarnEmitted) {
        console.warn(
          '[StakeLedger] non-archive RPC: ownership refreshes are skipped for blocks it no longer serves ' +
            `(configure an archive RPC for exact catch-up refreshes). Error: ${msg}`,
        )
        _nonArchiveRefreshWarnEmitted = true
      }
    } else {
      console.warn(`[StakeLedger] Failed to read on-chain ownership for tokenId=${tokenId}:`, err)
    }
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * True when (blockNumber, logIndex) is at or before the position the ledger has
 * already consumed (warm restart, replay). prefetchOwnershipForAction() and
 * recordAction() must agree on this, so both call this one function: if they
 * disagreed, prefetch would skip while recordAction went ahead and read an unseen
 * token as 0n.
 */
function isActionAlreadyProcessed(s: RuntimeState, blockNumber: bigint, logIndex: number): boolean {
  return blockNumber < s.lastBlock || (blockNumber === s.lastBlock && logIndex <= s.lastLogIndex)
}

/**
 * What step 2 of recordAction() charges the sender on top of the type-specific
 * cost: the extra recipients' amounts (the first recipient of a WITHDRAW is not
 * one) plus the validator tip, the last element of `amounts`. It sizes the
 * assumed balance of an unseen WITHDRAW sender, which must cover this as well:
 * real WITHDRAW actions carry a validator tip. A test checks it against step 2.
 */
function stepTwoChargeWei(rawAction: RawAction, isWithdraw: boolean): bigint {
  const amounts = rawAction.amounts ?? []
  const recipients = rawAction.recipients ?? []
  if (amounts.length === 0) return 0n
  let total = 0n
  for (let i = isWithdraw ? 1 : 0; i < recipients.length; i++) total += BigInt(amounts[i] ?? 0) * PRECISION
  return total + BigInt(amounts[amounts.length - 1] ?? 0) * PRECISION
}

/**
 * Token ids recordAction() may read the balance of (a superset is fine).
 * A WITHDRAW sender is left out: the withdraw has already moved the on-chain
 * balance, so a chain read would double-apply it (see recordAction).
 */
export function tokensTouchedByAction(rawAction: RawAction, validatorId: number): number[] {
  const ids = new Set<number>()
  const rawTypeName = ACTION_TYPE_NUM_TO_NAME[Number(rawAction.actionType) as keyof typeof ACTION_TYPE_NUM_TO_NAME]
  const isWithdraw = rawTypeName === 'WITHDRAW'
  if (!isWithdraw) ids.add(Number(rawAction.senderId))
  const receiverId = rawAction.receiverId ? Number(rawAction.receiverId) : 0
  if (receiverId !== 0) ids.add(receiverId)
  const recipients = rawAction.recipients ?? []
  for (let i = isWithdraw ? 1 : 0; i < recipients.length; i++) ids.add(Number(recipients[i]))
  if (validatorId) ids.add(validatorId)
  return [...ids].filter((id) => Number.isFinite(id))
}

/**
 * Load the real on-chain ownership of every token the action is about to touch
 * that this node has not seen yet. Call it BEFORE opening the transaction that
 * runs recordAction(). Never throws.
 */
export async function prefetchOwnershipForAction(params: {
  rawAction: RawAction
  validatorId: number
  blockNumber: bigint
  logIndex: number
}): Promise<void> {
  try {
    const s = await ensureBooted()
    if (s.halted) return
    // recordAction() skips actions it has already processed; don't spend RPC reads on them.
    if (isActionAlreadyProcessed(s, params.blockNumber, params.logIndex)) return
    const missing = tokensTouchedByAction(params.rawAction, params.validatorId).filter((id) => !s.ownership.has(id))
    if (missing.length === 0) return
    await Promise.all(
      missing.map(async (tokenId) => {
        const own = await fetchChainOwnership(tokenId)
        // Re-check after the await: a deposit or an earlier action may have cached a
        // newer value in the meantime, and a chain read must not overwrite it.
        if (own !== null && !s.ownership.has(tokenId)) s.ownership.set(tokenId, own)
      }),
    )
  } catch (err) {
    console.warn('[StakeLedger] prefetchOwnershipForAction failed (continuing without it):', err)
  }
}

function requestOwnershipRefresh(tokenId: number, readAtBlock: bigint): void {
  const queued = pendingOwnershipRefresh.get(tokenId)
  if (queued === undefined || readAtBlock > queued) pendingOwnershipRefresh.set(tokenId, readAtBlock)
}

/**
 * Re-read the queued tokens from chain, at the block recorded with each request,
 * and replace their cached ownership. Call it AFTER the transaction that ran
 * recordAction(). Never throws. A value that changed while the read was in flight
 * is newer than the read and is left alone (as in prefetchOwnershipForAction).
 */
export async function flushOwnershipRefreshes(): Promise<void> {
  if (pendingOwnershipRefresh.size === 0) return
  const requests = [...pendingOwnershipRefresh]
  pendingOwnershipRefresh.clear()
  try {
    const s = await ensureBooted()
    await Promise.all(
      requests.map(async ([tokenId, readAtBlock]) => {
        const before = s.ownership.get(tokenId)
        const own = await fetchChainOwnership(tokenId, readAtBlock)
        if (own !== null && s.ownership.get(tokenId) === before) s.ownership.set(tokenId, own)
      }),
    )
  } catch (err) {
    console.warn('[StakeLedger] flushOwnershipRefreshes failed:', err)
  }
}

/** Test hook: shorten the per-read timeout. */
export function _setOwnershipFetchTimeoutForTests(ms: number): void {
  OWNERSHIP_FETCH_TIMEOUT_MS = ms
}

/** Test hook: tokens currently queued for a post-transaction refresh. */
export function _pendingOwnershipRefreshForTests(): number[] {
  return [...pendingOwnershipRefresh.keys()]
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
 * row inserts and a final state-update. It performs NO RPC reads (a slow RPC
 * must not eat the transaction's timeout): unseen tokens are loaded by
 * prefetchOwnershipForAction() before the transaction opens.
 *
 * IMPORTANT (Post-Commit Mutation invariant): this function NEVER mutates
 * the in-memory singleton `s`. All state transitions are staged locally
 * (localMultiplier / localTotalCaw / stagedOwnership) and written to the DB
 * from those locals; the singleton is updated only by the callback returned
 * at the end, which the caller must execute strictly AFTER the transaction
 * commits. Mutating `s` inside this callback would reintroduce the orphan
 * mutation / double-count bug (DB rollback or Prisma deadlock-retry leaves
 * memory diverged from the chain). Returns null when no memory update is
 * due (halted, or action already processed). An action skipped for insufficient
 * balance returns a callback that only queues an ownership refresh for its
 * sender, so the refresh queue is touched only after a commit.
 */
export async function recordAction(
  tx: PrismaTransactionClient,
  params: RecordParams,
): Promise<(() => void) | null> {
  const s = await ensureBooted()
  if (s.halted) return null // Operator must reseed before we resume.

  // Skip already-processed actions on warm restart. ActionProcessor
  // resumes from lastId; we resume from (lastBlock, lastLogIndex).
  if (isActionAlreadyProcessed(s, params.blockNumber, params.logIndex)) return null

  const { rawAction, validatorId, blockNumber, blockTimestamp, txHash, logIndex, actionIndex } = params
  const senderId = Number(rawAction.senderId)

  // Local state staging for Post-Commit Mutation pattern.
  // DO NOT touch `s` below this line: every read goes through getOwn /
  // localMultiplier / localTotalCaw so a rolled-back or retried transaction
  // can never leak a partial state into the singleton.
  let localMultiplier = s.multiplier
  let localTotalCaw = s.totalCaw
  const stagedOwnership = new Map<number, bigint>()
  // Refresh requests are staged like ownership: they reach the module queue only
  // from the post-commit callback, never from inside the transaction.
  const refreshAfterCommit = new Map<number, bigint>()
  // Ownership lookup: the in-transaction staging map first (so a token touched
  // earlier in THIS action sees its own uncommitted delta), then the cache.
  // No RPC in here: unseen tokens were loaded by prefetchOwnershipForAction()
  // before the transaction opened, and anything still unseen reads as 0n.
  const getOwn = async (tokenId: number): Promise<bigint> => {
    const staged = stagedOwnership.get(tokenId)
    if (staged !== undefined) return staged
    return s.ownership.get(tokenId) ?? 0n
  }
  const setOwn = (tokenId: number, own: bigint) => { stagedOwnership.set(tokenId, own) }
  const localState = { ...s, multiplier: localMultiplier, totalCaw: localTotalCaw } as typeof s

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
    const senderOwn = await getOwn(senderId)
    const senderBalBefore = balanceOf(senderOwn, localMultiplier)
    let r: ReturnType<typeof spendAndDistribute>
    try {
      r = spendAndDistribute(senderOwn, localState, cost.spend * PRECISION, cost.communal * PRECISION)
    } catch (err: any) {
      if (typeof err?.message === 'string' && err.message.includes('Insufficient CAW balance')) {
        // Do NOT halt the whole ledger for a single user's apparent
        // shortfall -- prefetchOwnershipForAction already lazy-loads unseen
        // tokens from chain, so a genuine "Insufficient CAW balance"
        // here means this ONE sender is actually short, not that the
        // ledger has drifted. Refresh their cached balance from chain
        // (in case it's stale rather than genuinely insufficient) and
        // skip just this action; every other user's snapshot writes
        // continue unaffected.
        console.warn(
          `[StakeLedger] INSUFFICIENT_BALANCE_SKIP senderId=${senderId} action=${rawTypeName} ` +
          `block=${blockNumber} logIndex=${logIndex} (bal=${senderBalBefore}). Refreshing from chain and skipping this action.`,
        )
        // Skipped: nothing is applied, and nothing is queued from in here. The callback
        // queues the refresh once the transaction has committed, for the state just
        // before this action (the ledger did not apply it).
        return () => requestOwnershipRefresh(senderId, blockNumber - 1n)
      }
      throw err
    }
    if (r.communalDistributed > 0n) {
      multiplierEvents.push({
        before: localMultiplier,
        after: r.multiplier,
        communal: r.communalDistributed,
        subActionIndex: subActionIndex++,
      })
    }
    localMultiplier = r.multiplier
    localState.multiplier = r.multiplier
    setOwn(senderId, r.senderOwnership)
    pushTouch(
      senderId,
      r.senderBalance - senderBalBefore, // negative
      r.senderOwnership,
      r.senderBalance,
      'ACTION_SPEND_BASE',
      receiverId || null,
    )

    if (cost.receive > 0n && receiverId !== 0) {
      const recvOwn = await getOwn(receiverId)
      const recvBalBefore = balanceOf(recvOwn, localMultiplier)
      const recv = addToBalance(recvOwn, localMultiplier, cost.receive * PRECISION)
      setOwn(receiverId, recv.ownership)
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
    // CawProfileLedger.withdraw(): debits sender, decrements totalCaw.
    // Modelled as ACTION_SPEND_BASE so the chart's outgoing stack
    // surfaces it the same way as other type-specific costs.
    //
    // WITHDRAW replays an event that has ALREADY moved the on-chain balance, so
    // an unseen sender is never seeded from chain: cawOwnership() is a HEAD
    // read, which already includes this withdraw (double-subtract) and every
    // later event, and it would be an RPC read inside the transaction.
    // The withdraw succeeded on-chain, so the sender held at least `amount` plus
    // whatever step 2 charges (the validator tip and any extra recipients) before
    // it. For an unseen sender we assume exactly that: the totalCaw decrement stays
    // exact (it feeds the multiplier) and the sender is not wrongly skipped as
    // insufficient, at step 1 or at step 2.
    // It is an approximation. The persisted CawOwnershipCurrent and
    // User.onChainStakeWei rows are written from it and keep it until the token's
    // next action or a reconciler pass (which corrects upwards only), and a
    // restart drops the in-memory refresh below. After the commit the sender is
    // queued for a refresh at this block (requestOwnershipRefresh); an RPC without
    // that block's state does not serve it, and nothing is written then.
    const amount = (BigInt(rawAction.amounts?.[0] ?? 0)) * PRECISION
    const stagedSenderOwn = stagedOwnership.get(senderId)
    const cachedSenderOwn = stagedSenderOwn !== undefined ? stagedSenderOwn : s.ownership.get(senderId)
    let senderBal: bigint
    if (cachedSenderOwn !== undefined) {
      senderBal = balanceOf(cachedSenderOwn, localMultiplier)
    } else {
      senderBal = amount + stepTwoChargeWei(rawAction, true)
      refreshAfterCommit.set(senderId, blockNumber)
      console.warn(`[StakeLedger] WITHDRAW for unseen sender=${senderId}: assuming pre-withdraw balance == amount + step 2 charge (${senderBal}); ownership is refreshed from chain after commit when the RPC can serve block ${blockNumber}.`)
    }
    if (senderBal < amount) {
      // An unseen sender never reaches this branch (handled above), so a
      // genuine shortfall here means this ONE sender is
      // actually short, not that the ledger has drifted. Skip just
      // this action rather than halting every other user.
      console.warn(`[StakeLedger] INSUFFICIENT_BALANCE_SKIP WITHDRAW sender=${senderId} bal=${senderBal} amt=${amount}.`)
      return null
    }
    const newBal = senderBal - amount
    const newOwn = ownershipFromBalance(newBal, localMultiplier)
    setOwn(senderId, newOwn)
    localTotalCaw -= amount
    localState.totalCaw = localTotalCaw
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
      const recvOwn = await getOwn(recipientTokenId)
      const recvBalBefore = balanceOf(recvOwn, localMultiplier)
      const recv = addToBalance(recvOwn, localMultiplier, amountWei)
      setOwn(recipientTokenId, recv.ownership)
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
      const senderOwn = await getOwn(senderId)
      const senderBalBefore = balanceOf(senderOwn, localMultiplier)
      let r: ReturnType<typeof spendAndDistribute>
      try {
        r = spendAndDistribute(senderOwn, localState, amountTotal, 0n)
      } catch (err: any) {
        if (typeof err?.message === 'string' && err.message.includes('Insufficient CAW balance')) {
          // Same reasoning as recordAction's step1 handler.
          console.warn(
            `[StakeLedger] INSUFFICIENT_BALANCE_SKIP senderId=${senderId} action=${rawTypeName} (step2, tip send) ` +
            `block=${blockNumber} logIndex=${logIndex} (bal=${senderBalBefore}). Refreshing from chain and skipping this action.`,
          )
          // Skipped: see the step 1 handler; the callback queues the refresh after the commit.
          return () => requestOwnershipRefresh(senderId, blockNumber - 1n)
        }
        throw err
      }
      localMultiplier = r.multiplier
      localState.multiplier = r.multiplier // unchanged but assign for clarity
      setOwn(senderId, r.senderOwnership)
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
      const valOwn = await getOwn(validatorId)
      const valBalBefore = balanceOf(valOwn, localMultiplier)
      const val = addToBalance(valOwn, localMultiplier, validatorTipWei)
      setOwn(validatorId, val.ownership)
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
        multiplier: localMultiplier.toString(),
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
    const finalByToken = new Map<number, { ownership: bigint; balance: bigint }>()
    for (const t of touches) finalByToken.set(t.tokenId, { ownership: t.finalOwnership, balance: t.finalBalance })
    const now = new Date()
    for (const [tokenId, { ownership, balance }] of finalByToken) {
      await tx.cawOwnershipCurrent.upsert({
        where: { tokenId },
        create: { tokenId, ownership: ownership.toString() },
        update: { ownership: ownership.toString(), updatedAt: now },
      })
      // Mirror the contract-equivalent balance into User.onChainStakeWei so
      // /api/users/by-token reads see post-action state — same pattern as
      // recordDeposit. updateMany no-ops if the User row hasn't landed yet
      // (NftTransferWatcher will create it later).
      await tx.user.updateMany({
        where: { tokenId },
        data: {
          onChainStakeWei: balance.toString(),
          onChainStakeUpdatedAt: now,
        },
      })
    }
  }

  await tx.stakeLedgerState.upsert({
    where: { networkId: CAW_CLIENT_ID },
    create: {
      networkId: CAW_CLIENT_ID,
      totalCaw: localTotalCaw.toString(),
      multiplier: localMultiplier.toString(),
      lastBlock: blockNumber,
      lastLogIndex: logIndex,
    },
    update: {
      totalCaw: localTotalCaw.toString(),
      multiplier: localMultiplier.toString(),
      lastBlock: blockNumber,
      lastLogIndex: logIndex,
      updatedAt: new Date(),
    },
  })
  // Post-commit mutation callback: apply the staged state to the singleton.
  // The caller must invoke this exactly once, strictly AFTER
  // `await prisma.$transaction(...)` resolves. Invoking it earlier
  // reintroduces the orphan-mutation bug.
  // Return the in-memory mutation callback to be executed strictly AFTER
  // the DB transaction commits successfully. If the transaction rolls back
  // (e.g. timeout on commit), this callback is not invoked and `s` remains
  // completely untouched, preventing in-memory corruption on retry.
  return () => {
    s.multiplier = localMultiplier
    s.totalCaw = localTotalCaw
    s.lastBlock = blockNumber
    s.lastLogIndex = logIndex
    for (const [tokenId, own] of stagedOwnership) {
      s.ownership.set(tokenId, own)
    }
    // Queue the refreshes only now that the transaction has committed.
    for (const [tokenId, readAtBlock] of refreshAfterCommit) requestOwnershipRefresh(tokenId, readAtBlock)
  }
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
): Promise<{ tokenId: number; amountWei: bigint; afterOwnership: bigint } | null> {
  const s = await ensureBooted()
  if (s.halted) return null
  const { tokenId, amountWei, blockNumber, blockTimestamp, txHash, logIndex } = params

  // Dedup: a watcher restart catching up may replay the same Deposited
  // log. (txHash, logIndex) uniquely identifies the source event.
  const existing = await tx.cawOwnershipSnapshot.findFirst({
    where: { txHash, logIndex, reason: 'DEPOSIT' },
    select: { id: true },
  })
  if (existing) return null

  // Compute the post-deposit state WITHOUT mutating the in-memory
  // singleton `s` yet. addToBalance/balanceOf are pure — they read `s`
  // but don't write it. The mutation (s.totalCaw += / s.ownership.set)
  // must happen strictly AFTER the DB write below commits successfully:
  // on retry (checkpoint held, block range re-scanned), the dedup check
  // above only sees a row that made it to disk. If we mutated `s` before
  // the `tx.cawOwnershipSnapshot.create` and that create then threw
  // (caller's transaction rolls back, no row persists), a retry would
  // redo the dedup check (still finds nothing), fall through here again,
  // and mutate `s` a SECOND time for a deposit that was only ever
  // written to the DB once — silently inflating totalCaw/ownership in
  // memory while the DB stays correct. Computing `after` here and only
  // applying it post-commit closes that window.
  // Unseen token: start from 0n, exactly as if this were its first deposit.
  // Do NOT seed from the chain here. cawOwnership() is a HEAD read, so it
  // already includes this deposit and every later one: a HEAD-relative
  // reconstruction over-counts when an older deposit is replayed after newer
  // ones, mixes a HEAD balance with a past multiplier, and needs an RPC read
  // inside the caller's transaction. A token whose earlier deposits this node
  // missed ends up too low, and the daily reconciler picks that up as a
  // deposit (onChain > cached).
  const own = s.ownership.get(tokenId) ?? 0n
  const startingBalance = balanceOf(own, s.multiplier)
  const after = addToBalance(own, s.multiplier, amountWei)
  const nextTotalCaw = s.totalCaw + amountWei

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
  // Mirror the post-deposit balance into User.onChainStakeWei. /api/users/by-token
  // reads from this column and previously only got refreshed for users with a
  // non-null pendingDepositAmount — which the zap (ETH→profile+deposit) and
  // sponsored-mint flows don't set, so the FE saw 0 even though L2 had the CAW.
  // after.balance matches what cawBalanceOf(tokenId) returns on L2 (same
  // ownership × multiplier / 1e18 model — see contractMath.ts:18). Best-effort:
  // if the User row hasn't been indexed yet (Mint event lagging), the update
  // misses 0 rows and NftTransferWatcher will pick it up later.
  await tx.user.updateMany({
    where: { tokenId },
    data: {
      onChainStakeWei: after.balance.toString(),
      onChainStakeUpdatedAt: new Date(),
    },
  })
  // ⚠️ Do NOT mutate `s` here. This function runs inside the caller's
  // `prisma.$transaction(...)` callback. If the subsequent upsert throws
  // (or Prisma internally retries the callback), mutating `s` here would
  // leave the in-memory ledger drifted from the rolled-back DB state,
  // causing double-counting on the checkpoint retry.
  // The caller (DepositWatcher) must apply these mutations to `s` ONLY
  // after the transaction resolves successfully (Post-Commit Mutation).
  await tx.stakeLedgerState.upsert({
    where: { networkId: CAW_CLIENT_ID },
    create: {
      networkId: CAW_CLIENT_ID,
      totalCaw: nextTotalCaw.toString(),
      multiplier: s.multiplier.toString(),
      lastBlock: blockNumber,
      lastLogIndex: logIndex,
    },
    update: {
      totalCaw: nextTotalCaw.toString(),
      multiplier: s.multiplier.toString(),
      lastBlock: blockNumber,
      lastLogIndex: logIndex,
      updatedAt: new Date(),
    },
  })
  return { tokenId, amountWei, afterOwnership: after.ownership }
}

/**
 * Apply the deposit mutation to the in-memory singleton `s`.
 * MUST ONLY be called AFTER the DB transaction has successfully committed.
 */
export async function applyDepositToMemory(tokenId: number, amountWei: bigint, afterOwnership: bigint) {
  const s = await ensureBooted()
  s.totalCaw += amountWei
  s.ownership.set(tokenId, afterOwnership)
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
    onChain = BigInt(await getCawProfileLedger().rewardMultiplier({ blockTag: lastBlock }))
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
        onChain = BigInt(await getCawProfileLedger().rewardMultiplier())
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
        `Halting writes — operator must reseed (read CawProfileLedger state and overwrite StakeLedgerState + CawOwnershipCurrent).`,
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
  _nonArchiveRefreshWarnEmitted = false
  _cawProfileLedgerOverride = null
  pendingOwnershipRefresh.clear()
  OWNERSHIP_FETCH_TIMEOUT_MS = 5_000
}

/** For tests: inject a mock contract so verifyMultiplier never hits a real RPC. */
export function _setContractForTests(mock: { rewardMultiplier: (...args: any[]) => Promise<any>; cawOwnership?: (...args: any[]) => Promise<any> } | null): void {
  _cawProfileLedgerOverride = mock
    ? { rewardMultiplier: mock.rewardMultiplier, cawOwnership: mock.cawOwnership ?? (async () => 0n) }
    : null
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

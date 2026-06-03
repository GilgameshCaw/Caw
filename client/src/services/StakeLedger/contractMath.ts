// Pure functions mirroring CawProfileLedger state transitions
// (`solidity/contracts/CawProfileLedger.sol:200-289`). Bigint arithmetic
// matches the EVM's truncating integer division bit-for-bit; the only
// way these can diverge from the on-chain state is a bug here, which
// the snapshotter's per-event rewardMultiplier checksum will catch
// within a couple of actions.
//
// The contract's "precision" is 1e18.

const PRECISION = 10n ** 18n

export interface State {
  multiplier: bigint
  totalCaw: bigint
}

/** balance = ownership × multiplier / 1e18 */
export function balanceOf(ownership: bigint, multiplier: bigint): bigint {
  return (ownership * multiplier) / PRECISION
}

/** ownership = 1e18 × balance / multiplier */
export function ownershipFromBalance(balance: bigint, multiplier: bigint): bigint {
  return (PRECISION * balance) / multiplier
}

export interface SpendDistributeResult {
  /** New rewardMultiplier (unchanged on the refund-to-spender path). */
  multiplier: bigint
  /** Sender ownership AFTER applying the spend (and refund if denominator was too small). */
  senderOwnership: bigint
  /** Sender balance AFTER spend, in CAW (whole tokens × 1e18). */
  senderBalance: bigint
  /** Communal amount actually distributed via multiplier inflation. 0 on refund-to-spender. */
  communalDistributed: bigint
  /** True if the contract took the refund-to-spender branch instead of inflating multiplier. */
  refundedToSpender: boolean
}

/**
 * Mirror of `CawProfileLedger.spendAndDistribute(tokenId, amountToSpend, amountToDistribute)`
 * — the inner call shared by spendAndDistributeTokens and
 * spendDistributeAndAddTokensToBalance.
 *
 * Inputs are RAW 18-decimal amounts (whole CAW × 1e18). Caller passes
 * `senderOwnership` and `state` as-of just before this action.
 *
 * Reverts in the contract on insufficient balance — we mirror by
 * throwing here, but the indexer should never see that case for a
 * successfully-emitted ActionsProcessed event (the contract already
 * gated it).
 */
export function spendAndDistribute(
  senderOwnership: bigint,
  state: State,
  amountToSpend: bigint,
  amountToDistribute: bigint,
): SpendDistributeResult {
  const balance = balanceOf(senderOwnership, state.multiplier)
  if (balance < amountToSpend) {
    throw new Error(`[contractMath] Insufficient CAW balance — ledger drift? balance=${balance} spend=${amountToSpend}`)
  }
  let newBalance = balance - amountToSpend
  const denominator = state.totalCaw > balance ? state.totalCaw - balance : 0n

  let newMultiplier = state.multiplier
  let communalDistributed = 0n
  let refundedToSpender = false

  if (denominator >= amountToDistribute && denominator > 0n) {
    // Normal path: inflate multiplier proportionally.
    newMultiplier = state.multiplier + (state.multiplier * amountToDistribute) / denominator
    communalDistributed = amountToDistribute
  } else {
    // Refund-to-spender path. See `CawProfileLedger.sol:237-242`.
    newBalance += amountToDistribute
    refundedToSpender = true
  }

  const newOwnership = ownershipFromBalance(newBalance, newMultiplier)
  return {
    multiplier: newMultiplier,
    senderOwnership: newOwnership,
    senderBalance: newBalance,
    communalDistributed,
    refundedToSpender,
  }
}

/**
 * Mirror of `CawProfileLedger.addToBalance(tokenId, amount)` — used both
 * for action recipients (via spendDistributeAndAddTokensToBalance after
 * the spend) and for L1->L2 deposits.
 *
 * IMPORTANT: this must run with the multiplier as it is AFTER any prior
 * spendAndDistribute in the same action — recipient credit happens
 * AFTER the multiplier change in the contract sequence
 * (`spendDistributeAndAddTokensToBalance` calls spendAndDistribute then
 * addToBalance).
 */
export function addToBalance(
  recipientOwnership: bigint,
  multiplier: bigint,
  amount: bigint,
): { ownership: bigint; balance: bigint } {
  const balance = balanceOf(recipientOwnership, multiplier) + amount
  return {
    ownership: ownershipFromBalance(balance, multiplier),
    balance,
  }
}

export { PRECISION }

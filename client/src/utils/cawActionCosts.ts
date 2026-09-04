// Per-action CAW costs, mirroring CawActions._applyAction (`solidity/contracts/CawActions.sol:619`).
//
// Three slots per action type:
//   - SPEND:    whole CAW the sender pays (subtracted from sender balance)
//   - COMMUNAL: whole CAW that inflates rewardMultiplier (everyone earns proportionally)
//   - RECEIVE:  whole CAW credited directly to the recipient's balance
//
// SPEND = COMMUNAL + RECEIVE for actions with a fixed protocol cost. The
// contract calls `spendDistributeAndAddTokensToBalance(sender, SPEND, COMMUNAL, recipient, RECEIVE)`
// for LIKE/RECAW/FOLLOW and `spendAndDistributeTokens(sender, SPEND, COMMUNAL)` for CAW.
//
// Variable-cost types (TIP via OTHER, WITHDRAW) carry their amounts in the
// action's `amounts[]` array — see ActionData. They have zero fixed cost
// here; the snapshotter reads the per-action amounts.

export type FixedCostActionType = 'CAW' | 'LIKE' | 'RECAW' | 'FOLLOW'

export interface ActionCost {
  spend: bigint
  communal: bigint
  receive: bigint
}

export const ACTION_BASELINE_AND_CAP = {
  CAW:    { baseline: 5000n,  ethCap: 500_000_000_000n },   // 5e11
  LIKE:   { baseline: 2000n,  ethCap: 200_000_000_000n },   // 2e11
  RECAW:  { baseline: 4000n,  ethCap: 400_000_000_000n },   // 4e11
  FOLLOW: { baseline: 30000n, ethCap: 3_000_000_000_000n }, // 30e11
} as const

export const CAP_STALE_THRESHOLD_SECONDS = 86400n // 24 hours (solidity/contracts/CawActions.sol:229)

/**
 * Compute the effective action cost taking into account CawActions._getCost dynamic capping.
 * If capRatio == 0 or if the oracle sample is older than CAP_STALE_THRESHOLD (24h),
 * baseline manifesto costs apply.
 * Mirrors CawActions._getCost and CawActions._applyAction split logic.
 */
export function getActionCost(
  typeName: FixedCostActionType,
  capRatio: bigint = 0n,
  lastUpdatedAt: bigint = 0n,
  currentTimestampSeconds: bigint = 0n,
): ActionCost {
  const spec = ACTION_BASELINE_AND_CAP[typeName]
  let cost: bigint = spec.baseline

  const isFresh =
    capRatio > 0n &&
    (lastUpdatedAt === 0n ||
      currentTimestampSeconds === 0n ||
      (currentTimestampSeconds >= lastUpdatedAt &&
        currentTimestampSeconds - lastUpdatedAt <= CAP_STALE_THRESHOLD_SECONDS))

  if (isFresh) {
    let capped = ((spec.ethCap << 112n) / capRatio) / 10n**18n
    if (capped === 0n) capped = 1n
    if (capped < spec.baseline) cost = capped
  }

  if (typeName === 'CAW') {
    return { spend: cost, communal: cost, receive: 0n }
  } else if (typeName === 'LIKE') {
    const communal = cost / 5n
    return { spend: cost, communal, receive: cost - communal }
  } else if (typeName === 'RECAW') {
    const communal = cost / 2n
    return { spend: cost, communal, receive: cost - communal }
  } else if (typeName === 'FOLLOW') {
    const communal = cost / 5n
    return { spend: cost, communal, receive: cost - communal }
  }
  return { spend: cost, communal: cost, receive: 0n }
}

export const ACTION_COST: Record<FixedCostActionType, ActionCost> = {
  CAW:    getActionCost('CAW', 0n),
  LIKE:   getActionCost('LIKE', 0n),
  RECAW:  getActionCost('RECAW', 0n),
  FOLLOW: getActionCost('FOLLOW', 0n),
}

// Numeric tag mapping. The contract uses a uint8 enum; the database uses
// the string enum (Prisma `ActionType`). The tags below mirror
// `solidity/contracts/CawActions.sol:619` ActionType ordering.
export const ACTION_TYPE_NUM_TO_NAME = {
  0: 'CAW',
  1: 'LIKE',
  2: 'UNLIKE',
  3: 'RECAW',
  4: 'FOLLOW',
  5: 'UNFOLLOW',
  6: 'WITHDRAW',
  7: 'OTHER',
} as const

export type ActionTypeName = (typeof ACTION_TYPE_NUM_TO_NAME)[keyof typeof ACTION_TYPE_NUM_TO_NAME]

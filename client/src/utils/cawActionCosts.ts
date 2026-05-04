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

export const ACTION_COST: Record<FixedCostActionType, ActionCost> = {
  CAW:    { spend: 5000n,  communal: 5000n, receive: 0n },
  LIKE:   { spend: 2000n,  communal: 400n,  receive: 1600n },
  RECAW:  { spend: 4000n,  communal: 2000n, receive: 2000n },
  FOLLOW: { spend: 30000n, communal: 6000n, receive: 24000n },
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

import { getRequiredStake } from '~/constants/stakingRequirements'

export class InsufficientStakeError extends Error {
  public readonly currentAmount: bigint | undefined
  public readonly requiredAmount: bigint
  public readonly actionType: 'post' | 'like' | 'repost'

  constructor(
    currentAmount: bigint | undefined,
    requiredAmount: bigint,
    actionType: 'post' | 'like' | 'repost' = 'post'
  ) {
    super(`Insufficient CAW staked. Required: ${requiredAmount}, Current: ${currentAmount || 0}`)
    this.name = 'InsufficientStakeError'
    this.currentAmount = currentAmount
    this.requiredAmount = requiredAmount
    this.actionType = actionType
  }
}

// Helper to determine action type from action key
export function getActionTypeForModal(actionKey: string): 'post' | 'like' | 'repost' {
  switch (actionKey) {
    case 'like':
    case 'unlike':
      return 'like'
    case 'recaw':
      return 'repost'
    case 'caw':
    case 'follow':
    case 'unfollow':
    default:
      return 'post'
  }
}
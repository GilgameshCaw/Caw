import { getRequiredStake } from '~/constants/stakingRequirements'

export class InsufficientStakeError extends Error {
  public readonly currentAmount: bigint | undefined
  public readonly requiredAmount: bigint
  public readonly actionType: 'post' | 'like' | 'repost' | 'profile'

  constructor(
    currentAmount: bigint | undefined,
    requiredAmount: bigint,
    actionType: 'post' | 'like' | 'repost' | 'profile' = 'post'
  ) {
    super(`Insufficient CAW staked. Required: ${requiredAmount}, Current: ${currentAmount || 0}`)
    this.name = 'InsufficientStakeError'
    this.currentAmount = currentAmount
    this.requiredAmount = requiredAmount
    this.actionType = actionType
  }
}

// Helper to determine action type from action key
export function getActionTypeForModal(actionKey: string): 'post' | 'like' | 'repost' | 'profile' {
  switch (actionKey) {
    case 'like':
    case 'unlike':
      return 'like'
    case 'recaw':
      return 'repost'
    case 'other':
      return 'profile'
    case 'caw':
    case 'follow':
    case 'unfollow':
    default:
      return 'post'
  }
}
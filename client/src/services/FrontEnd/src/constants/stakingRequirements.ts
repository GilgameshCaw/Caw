// Minimum CAW staking requirements for various actions
// All values are in wei (1 CAW = 10^18 wei)

export const STAKING_REQUIREMENTS = {
  // Minimum stake required to perform any action
  MIN_STAKE_POST: 1000n * 10n**18n,     // 1,000 CAW to post
  MIN_STAKE_LIKE: 100n * 10n**18n,      // 100 CAW to like
  MIN_STAKE_REPOST: 100n * 10n**18n,    // 100 CAW to repost
  MIN_STAKE_FOLLOW: 100n * 10n**18n,    // 100 CAW to follow
  MIN_STAKE_COMMENT: 100n * 10n**18n,   // 100 CAW to comment
  MIN_STAKE_QUOTE: 500n * 10n**18n,     // 500 CAW to quote
} as const

// Helper function to check if user has sufficient stake
export const hasMinimumStake = (
  stakedAmount: bigint | undefined,
  actionType: keyof typeof STAKING_REQUIREMENTS
): boolean => {
  if (!stakedAmount) return false
  return stakedAmount >= STAKING_REQUIREMENTS[actionType]
}

// Helper to get required amount for an action
export const getRequiredStake = (
  actionType: keyof typeof STAKING_REQUIREMENTS
): bigint => {
  return STAKING_REQUIREMENTS[actionType]
}
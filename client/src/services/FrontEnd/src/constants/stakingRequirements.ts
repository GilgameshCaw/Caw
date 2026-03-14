// Minimum CAW staking requirements for various actions
// All values are in wei (1 CAW = 10^18 wei)

import { useClientConfigStore } from '~/store/clientConfigStore'

const BASE_VALIDATOR_TIP = BigInt(import.meta.env.VITE_VALIDATOR_TIP || "1000")
const TIP_PER_REPLICATION_CHAIN = BigInt(import.meta.env.VITE_TIP_PER_CHAIN || "500")

export const STAKING_REQUIREMENTS = {
  MIN_STAKE_POST: 5000n * 10n**18n,     // 5,000 CAW to post
  MIN_STAKE_LIKE: 2000n * 10n**18n,     // 2,000 CAW to like
  MIN_STAKE_REPOST: 4000n * 10n**18n,   // 4,000 CAW to repost
  MIN_STAKE_FOLLOW: 30000n * 10n**18n,  // 30,000 CAW to follow
  MIN_STAKE_COMMENT: 5000n * 10n**18n,  // 5,000 CAW to comment
  MIN_STAKE_QUOTE: 5000n * 10n**18n,    // 5,000 CAW to quote
} as const

/** Get the validator tip in wei (accounts for replication chains) */
function getValidatorTipWei(): bigint {
  const chainCount = useClientConfigStore.getState().getReplicationChainCount()
  const tipInWholeTokens = BASE_VALIDATOR_TIP + (TIP_PER_REPLICATION_CHAIN * BigInt(chainCount))
  return tipInWholeTokens * 10n**18n
}

// Helper function to check if user has sufficient stake (includes validator tip)
export const hasMinimumStake = (
  stakedAmount: bigint | undefined,
  actionType: keyof typeof STAKING_REQUIREMENTS
): boolean => {
  if (!stakedAmount) return false
  const required = STAKING_REQUIREMENTS[actionType] + getValidatorTipWei()
  return stakedAmount >= required
}

// Helper to get required amount for an action (includes validator tip)
export const getRequiredStake = (
  actionType: keyof typeof STAKING_REQUIREMENTS
): bigint => {
  return STAKING_REQUIREMENTS[actionType] + getValidatorTipWei()
}
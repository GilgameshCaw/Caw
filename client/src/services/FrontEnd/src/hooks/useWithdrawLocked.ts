/**
 * useWithdrawLocked
 *
 * Reads CawProfileMinter's per-tokenId withdraw-gate state and reports back:
 *   - kind: 'none' | 'time_lock' | 'kyc' | 'loading'
 *   - For 'time_lock': unlockAtSec (the Unix second the lock expires)
 *   - For 'kyc': level (2, 3, 4, …)
 *
 * Returns `isLocked = true` only when the gate is currently closed.
 *
 * State model (matches CawProfileMinter post-2026-06 remap):
 *   withdrawKycLevel[tokenId] = 0 → no gate (default; never written)
 *                              = 1 → 180-day time-lock from mintedAt[tokenId]
 *                              ≥ 2 → KYC verifier required at that level
 *   mintedAt[tokenId] = 0 → not gated regardless of level (defensive)
 *
 * Returns 'none' for tokenId undefined / 0.
 */

import { useReadContract } from 'wagmi'
import { cawProfileMinterAbi } from '~/../../../abi/generated'
import { CAW_NAMES_MINTER_ADDRESS } from '~/../../../abi/addresses'
import { chains } from '~/config/chains'

// 180 days, matching Minter's WITHDRAW_TIMELOCK constant. If the contract
// constant ever changes, update this — it's a UI countdown helper, not a
// security boundary (the contract revert is authoritative).
const WITHDRAW_TIMELOCK_SEC = 180 * 24 * 60 * 60

export interface WithdrawLockState {
  isLocked: boolean
  isLoading: boolean
  kind: 'none' | 'time_lock' | 'kyc' | 'loading'
  /** For 'time_lock' only — Unix seconds when withdraw unlocks. */
  unlockAtSec?: number
  /** For 'kyc' only — the level (2, 3, 4, …). */
  level?: number
}

export function useWithdrawLocked(tokenId: number | undefined): WithdrawLockState {
  const enabled = tokenId != null && tokenId > 0

  const { data: levelData, isLoading: levelLoading } = useReadContract({
    address: CAW_NAMES_MINTER_ADDRESS,
    abi: cawProfileMinterAbi,
    chainId: chains.l1.chainId,
    functionName: 'withdrawKycLevel',
    args: [tokenId ?? 0],
    query: { enabled },
  })

  const { data: mintedAtData, isLoading: mintedAtLoading } = useReadContract({
    address: CAW_NAMES_MINTER_ADDRESS,
    abi: cawProfileMinterAbi,
    chainId: chains.l1.chainId,
    functionName: 'mintedAt',
    args: [tokenId ?? 0],
    query: { enabled },
  })

  const isLoading = levelLoading || mintedAtLoading

  if (!enabled) {
    return { isLocked: false, isLoading: false, kind: 'none' }
  }
  if (isLoading) {
    return { isLocked: false, isLoading: true, kind: 'loading' }
  }

  const level = Number(levelData ?? 0)
  const mintedAt = Number(mintedAtData ?? 0)

  // mintedAt == 0 is the authoritative "not gated" signal — the contract
  // returns early before reading `level`. Mirror that here so a stale
  // level read can't show a spurious lock banner during state transitions.
  if (mintedAt === 0 || level === 0) {
    return { isLocked: false, isLoading: false, kind: 'none' }
  }

  if (level === 1) {
    const unlockAtSec = mintedAt + WITHDRAW_TIMELOCK_SEC
    const isLocked = Math.floor(Date.now() / 1000) < unlockAtSec
    return {
      isLocked,
      isLoading: false,
      kind: 'time_lock',
      unlockAtSec,
    }
  }

  // level >= 2 → KYC required. Whether the user has KYC'd is checked
  // separately at unlock time; from the FE's perspective the banner
  // always renders until they go through verification.
  return {
    isLocked: true,
    isLoading: false,
    kind: 'kyc',
    level,
  }
}

/**
 * useWithdrawLocked
 *
 * Reads the `mintedLocked` mapping on CawProfileMinter to determine whether a
 * given tokenId has its withdrawals disabled (i.e. was minted via the card
 * payment path and has not yet completed KYC).
 *
 * Returns { isLocked: boolean, isLoading: boolean }.
 * When tokenId is undefined or 0 the query is disabled and isLocked is false.
 */

import { useReadContract } from 'wagmi'
import { cawProfileMinterAbi } from '~/../../../abi/generated'
import { CAW_NAMES_MINTER_ADDRESS } from '~/../../../abi/addresses'
import { chains } from '~/config/chains'

export function useWithdrawLocked(tokenId: number | undefined): {
  isLocked: boolean
  isLoading: boolean
} {
  const { data, isLoading } = useReadContract({
    address: CAW_NAMES_MINTER_ADDRESS,
    abi: cawProfileMinterAbi,
    chainId: chains.l1.chainId,
    functionName: 'mintedLocked',
    args: [tokenId ?? 0],
    query: { enabled: tokenId != null && tokenId > 0 },
  })

  return {
    isLocked: data === true,
    isLoading,
  }
}

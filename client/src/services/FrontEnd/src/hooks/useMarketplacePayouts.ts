/**
 * useMarketplacePayouts
 *
 * Reads the H-15 pull-pattern pendingPayouts balance from
 * cawProfileMarketplace for a given seller address and exposes
 * withdrawPayouts / withdrawPayoutsTo write helpers.
 *
 * V2 change: sale proceeds NO LONGER push to the seller's on-chain balance
 * directly. They accumulate in pendingPayouts[seller] until the seller calls
 * withdrawPayouts() (or withdrawPayoutsTo(recipient) for a different address).
 */

import { useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { CAW_NAME_MARKETPLACE_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileMarketplaceAbi } from '~/../../../abi/generated'
import { chains } from '~/config/chains'

export interface MarketplacePayouts {
  /** Raw CAW wei sitting in pendingPayouts[seller]. Null while loading. */
  pending: bigint | null
  loaded: boolean
  /** Withdraw all proceeds to the connected wallet address. */
  withdraw: () => void
  /** Withdraw all proceeds to an arbitrary recipient. */
  withdrawTo: (recipient: `0x${string}`) => void
  isPending: boolean
  isConfirming: boolean
  isSuccess: boolean
  refetch: () => void
}

export function useMarketplacePayouts(sellerAddress: `0x${string}` | undefined): MarketplacePayouts {
  const enabled = !!sellerAddress

  const {
    data,
    isLoading,
    refetch,
  } = useReadContract({
    address: CAW_NAME_MARKETPLACE_ADDRESS,
    abi: cawProfileMarketplaceAbi,
    functionName: 'pendingPayouts',
    args: [sellerAddress ?? '0x0000000000000000000000000000000000000000'],
    chainId: chains.l2.chainId,
    query: { enabled },
  })

  const {
    writeContract,
    data: txHash,
    isPending: isWritePending,
    reset,
  } = useWriteContract()

  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  })

  // Refetch after tx confirms so the pending balance updates immediately.
  if (isSuccess && txHash) {
    refetch()
    reset()
  }

  const withdraw = () => {
    writeContract({
      address: CAW_NAME_MARKETPLACE_ADDRESS,
      abi: cawProfileMarketplaceAbi,
      functionName: 'withdrawPayouts',
      args: [],
    })
  }

  const withdrawTo = (recipient: `0x${string}`) => {
    writeContract({
      address: CAW_NAME_MARKETPLACE_ADDRESS,
      abi: cawProfileMarketplaceAbi,
      functionName: 'withdrawPayoutsTo',
      args: [recipient],
    })
  }

  return {
    pending: data != null ? (data as bigint) : null,
    loaded: !isLoading,
    withdraw,
    withdrawTo,
    isPending: isWritePending,
    isConfirming,
    isSuccess,
    refetch,
  }
}

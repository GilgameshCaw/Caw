import { useReadContracts } from 'wagmi'
import { cawNetworkManagerAbi } from '~/../../../abi/generated'
import { NETWORK_MANAGER_ADDRESS } from '~/../../../abi/addresses'
import { chains } from '~/config/chains'

export interface NetworkFees {
  depositFee: bigint | null
  authFee: bigint | null
  withdrawFee: bigint | null
  mintFee: bigint | null
  /**
   * Maximum protocol fee this Network can ever charge for any single fee type.
   * Committed at registration; can only be lowered. Read via
   * NetworkManager.getFeeCeiling(networkId).
   */
  feeCeiling: bigint | null
  isLoading: boolean
}

/**
 * Read the per-Network protocol-fee quad plus the upper-bound fee ceiling.
 * All values are in raw CAW wei (18 decimals). The caller is responsible for
 * formatting; this hook only does the contract reads.
 */
export function useNetworkFees(networkId: number | undefined, enabled = true): NetworkFees {
  const ready = enabled && typeof networkId === 'number'

  const { data, isLoading } = useReadContracts({
    contracts: [
      {
        address: NETWORK_MANAGER_ADDRESS,
        abi: cawNetworkManagerAbi,
        chainId: chains.l1.chainId,
        functionName: 'getDepositFee',
        args: [networkId ?? 0],
      },
      {
        address: NETWORK_MANAGER_ADDRESS,
        abi: cawNetworkManagerAbi,
        chainId: chains.l1.chainId,
        functionName: 'getAuthFee',
        args: [networkId ?? 0],
      },
      {
        address: NETWORK_MANAGER_ADDRESS,
        abi: cawNetworkManagerAbi,
        chainId: chains.l1.chainId,
        functionName: 'getWithdrawFee',
        args: [networkId ?? 0],
      },
      {
        address: NETWORK_MANAGER_ADDRESS,
        abi: cawNetworkManagerAbi,
        chainId: chains.l1.chainId,
        functionName: 'getMintFee',
        args: [networkId ?? 0],
      },
      {
        address: NETWORK_MANAGER_ADDRESS,
        abi: cawNetworkManagerAbi,
        chainId: chains.l1.chainId,
        functionName: 'getFeeCeiling',
        args: [networkId ?? 0],
      },
    ],
    query: { enabled: ready },
  })

  return {
    depositFee:  (data?.[0]?.result as bigint | undefined) ?? null,
    authFee:     (data?.[1]?.result as bigint | undefined) ?? null,
    withdrawFee: (data?.[2]?.result as bigint | undefined) ?? null,
    mintFee:     (data?.[3]?.result as bigint | undefined) ?? null,
    feeCeiling:  (data?.[4]?.result as bigint | undefined) ?? null,
    isLoading,
  }
}

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
   * V2 per-fee ceilings. Each ceiling is the maximum the Network can ever
   * charge for that specific fee type. Committed at registration; can only
   * be lowered via lowerXxxFeeCeiling(). Read via
   * NetworkManager.getXxxFeeCeiling(networkId).
   */
  withdrawFeeCeiling: bigint | null
  depositFeeCeiling:  bigint | null
  authFeeCeiling:     bigint | null
  mintFeeCeiling:     bigint | null
  isLoading: boolean
}

/**
 * Read the per-Network protocol-fee quad plus the four per-fee upper-bound
 * ceilings (V2). All values are in raw CAW wei (18 decimals). The caller is
 * responsible for formatting; this hook only does the contract reads.
 */
export function useNetworkFees(networkId: number | undefined, enabled = true): NetworkFees {
  const ready = enabled && typeof networkId === 'number'

  const { data, isLoading } = useReadContracts({
    contracts: [
      // [0] current fees
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
      // [4] per-fee ceilings (V2)
      {
        address: NETWORK_MANAGER_ADDRESS,
        abi: cawNetworkManagerAbi,
        chainId: chains.l1.chainId,
        functionName: 'getWithdrawFeeCeiling',
        args: [networkId ?? 0],
      },
      {
        address: NETWORK_MANAGER_ADDRESS,
        abi: cawNetworkManagerAbi,
        chainId: chains.l1.chainId,
        functionName: 'getDepositFeeCeiling',
        args: [networkId ?? 0],
      },
      {
        address: NETWORK_MANAGER_ADDRESS,
        abi: cawNetworkManagerAbi,
        chainId: chains.l1.chainId,
        functionName: 'getAuthFeeCeiling',
        args: [networkId ?? 0],
      },
      {
        address: NETWORK_MANAGER_ADDRESS,
        abi: cawNetworkManagerAbi,
        chainId: chains.l1.chainId,
        functionName: 'getMintFeeCeiling',
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
    withdrawFeeCeiling: (data?.[4]?.result as bigint | undefined) ?? null,
    depositFeeCeiling:  (data?.[5]?.result as bigint | undefined) ?? null,
    authFeeCeiling:     (data?.[6]?.result as bigint | undefined) ?? null,
    mintFeeCeiling:     (data?.[7]?.result as bigint | undefined) ?? null,
    isLoading,
  }
}

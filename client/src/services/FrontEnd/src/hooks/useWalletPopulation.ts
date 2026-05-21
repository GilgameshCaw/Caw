/**
 * useWalletPopulation.ts
 *
 * Detects which Population the currently-connected wallet belongs to by
 * inspecting the bytecode at the wallet's address.
 *
 * Population A — plain EOA: no bytecode (code === undefined or '0x' or length 0)
 * Population B — EIP-7702 delegated EOA: code starts with 0xef0100 AND is
 *               exactly 23 bytes (the canonical 7702 delegation designator,
 *               3-byte magic + 20-byte implementation address).
 * Population C — other smart-contract account (e.g. Safe, Gnosis)
 * none         — no wallet connected
 */

import { useMemo } from 'react'
import { useAccount, usePublicClient } from 'wagmi'
import { useQuery } from '@tanstack/react-query'

export type WalletPopulation = 'A' | 'B' | 'C' | 'none'

export interface UseWalletPopulationReturn {
  population: WalletPopulation
  loading: boolean
  address: `0x${string}` | undefined
}

/**
 * Classifies a hex bytecode string into A / B / C.
 * Exported for unit testing without React.
 */
export function classifyBytecode(code: string | undefined): 'A' | 'B' | 'C' {
  // Undefined or empty → plain EOA
  if (!code || code === '0x' || code.length === 0) return 'A'

  // EIP-7702 delegation designator: exactly 0xef0100 + 20 byte address = 23 bytes.
  // Hex representation: '0x' prefix + 46 chars = 48 chars total.
  const EIP7702_MAGIC = '0xef0100'
  if (
    code.toLowerCase().startsWith(EIP7702_MAGIC) &&
    code.length === 48 // '0x' + 46 hex chars = 23 bytes
  ) {
    return 'B'
  }

  return 'C'
}

export function useWalletPopulation(): UseWalletPopulationReturn {
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient()

  const { data: bytecode, isLoading } = useQuery({
    queryKey: ['wallet-bytecode', address],
    queryFn: async () => {
      if (!publicClient || !address) return undefined
      return publicClient.getCode({ address })
    },
    enabled: isConnected && !!address && !!publicClient,
    // Match project-wide staleTime of 5 min (project_infura_quota_dials.md)
    staleTime: 5 * 60 * 1000,
    // Reconnect / address change triggers a refetch automatically via queryKey
  })

  const population = useMemo<WalletPopulation>(() => {
    if (!isConnected || !address) return 'none'
    if (isLoading) return 'none'
    // bytecode from getCode is Hex | undefined; convert to string for classifier
    const code = bytecode === undefined ? undefined : (bytecode as string)
    return classifyBytecode(code)
  }, [isConnected, address, isLoading, bytecode])

  return {
    population,
    loading: isConnected && !!address && isLoading,
    address,
  }
}

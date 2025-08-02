// src/hooks/useCawonce.ts
import { useEffect } from 'react'
import { usePublicClient }         from 'wagmi';
import { useQuery }   from '@tanstack/react-query'
import { readContract } from '@wagmi/core'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { cawActionsAbi }        from '~/../../../abi/generated'
import { CAW_ACTIONS_ADDRESS }  from '~/../../../abi/addresses'
import { baseSepolia }       from 'wagmi/chains'
import { wagmiConfig } from "~/config/Web3Provider";

/**
 * When the activeTokenId changes, fetch on-chain `nextCawonce`
 * and write it into your token store. Retries automatically if
 * the hook is still mounted.
 */
export function useCawonceSync() {
  const activeTokenId = useTokenDataStore((s) => s.activeTokenId)
  const setCawonce    = useTokenDataStore((s) => s.setCawonce)
  console.log("USE CAWONCE SYNC");

  const { data } = useQuery({
    queryKey: ['nextCawonce', activeTokenId],
    queryFn: async () => {
      console.log("Fetch cawonce", activeTokenId, 'id')

      if (!activeTokenId) return undefined;
      // Wagmi’s readContract will use your default public client automatically
      const result = await readContract(wagmiConfig, {
        address:      CAW_ACTIONS_ADDRESS,
        abi:          cawActionsAbi,
        functionName: "nextCawonce",
        args:         [activeTokenId],
        chainId:      baseSepolia.id,
      });
      // The return value is a BigInt in v1
      return (typeof result === "bigint" ? result : BigInt(result as any)) as bigint;
    },
    query: {enabled:   Boolean(activeTokenId)},
    staleTime: 30_000,
  })

  useEffect(() => {
    console.log("DATA (cawocne) returned ----", data, activeTokenId)
    if (data != null) {
      // data is a BigInt or BigNumber depending on your client config
      const raw = typeof data === 'bigint' ? data : data.toBigInt?.() ?? BigInt(data)
      setCawonce(activeTokenId!, Number(raw))
    }
  }, [data, activeTokenId, setCawonce])
}

// client/src/services/FrontEnd/src/hooks/useTokenDataUpdate.tsx

import { useEffect, useState } from "react"
import { useAccount, useReadContract } from "wagmi"
import { Address } from "viem"
import { baseSepolia, sepolia } from "wagmi/chains"
import { CAW_NAMES_L2_ADDRESS, CAW_NAMES_ADDRESS } from "~/../../../abi/addresses";
import { cawNameAbi, cawNameL2Abi } from "~/../../../abi/generated"
import { useTokenDataStore } from "~/store/tokenDataStore"
import TOKENS from "~/constants/tokens"
// import { useQuery } from "@tanstack/react-query"
import { TokenData } from "~/types";
import { apiFetch } from "~/api/client";

interface RawToken {
  tokenId:       bigint
  username:      string
  owner:         Address
  ownerBalance:  bigint
  withdrawable:  bigint
}

export default function useTokenDataUpdate() {
  const { address } = useAccount()
  const setTokensForAddress = useTokenDataStore(s => s.setTokensForAddress)
  const tokensByAddress = useTokenDataStore(s => s.tokensByAddress)
  const activeTokenIdByAddress = useTokenDataStore(s => s.activeTokenIdByAddress)

  const setActiveTokenIdForAddress = useTokenDataStore(s => s.setActiveTokenIdForAddress)
  const setLastAddress = useTokenDataStore(s => s.setLastAddress)
  const lastAddress = useTokenDataStore(s => s.lastAddress)

  const viewedAddress = ((address ?? lastAddress)?.toLowerCase()) as Address | undefined
  console.log("has address?", !!address, address ?? null, "viewedAddress:", viewedAddress ?? null)

  const { data: rawTokens, isError, error, isLoading, isLoadingError } = useReadContract({
    address: CAW_NAMES_ADDRESS,
    chainId: sepolia.id,
    abi: cawNameAbi,
    functionName: "tokens",
    args: [viewedAddress as Address],

    query: {
      enabled: !!viewedAddress,
      refetchInterval: 5000, // Refetch every 5 seconds to keep data fresh
      staleTime: 2000, // Consider data stale after 2 seconds
    }
  })


  // Set active token for this address if not already set
  if (viewedAddress && rawTokens && rawTokens.length > 0) {
    const activeTokenIdForAddress = activeTokenIdByAddress[viewedAddress]
    if (activeTokenIdForAddress === undefined) {
      setActiveTokenIdForAddress(viewedAddress, Number(rawTokens[0].tokenId))
    }
  }

  // Only set lastAddress on initial load if it's not already set
  // Don't update it when wallet address changes - that's handled by manual username selection
  if (!!address && rawTokens && rawTokens.length > 0 && !lastAddress) {
    setLastAddress(address)
  }

  console.log("TOKEN DATA FROM L1:", rawTokens, isError, error)

  const { data: l2TokenData, isLoading: balancesLoading  } = useReadContract({
    address: CAW_NAMES_L2_ADDRESS,
    chainId:      baseSepolia.id,
    abi:          cawNameL2Abi,
    functionName: "getTokens",
    query: {
      enabled: !!rawTokens && rawTokens.length > 0,
      refetchInterval: 5000, // Refetch every 5 seconds to keep data fresh
      staleTime: 2000, // Consider data stale after 2 seconds
    },
    args: [(rawTokens ?? []).map((token) => Number(token.tokenId))],
  })
  console.log("TOKEN DATA FROM L2:", l2TokenData, isError, error)


  // price fetch
  // const { data: priceMap } = useQuery({
  //   queryKey: ["prices"],
  //   queryFn: async () => {
  //     return { data: {
  //       // TODO: read this from ETH
  //       // TODO: read this from ETH
  //       // TODO: read this from ETH
  //       'a-hunters-dream': 10000n,
  //       'ethereum': 10000n
  //     }
  //   }
  //     const ids = ["ethereum", ...Object.values(TOKENS).map(t => t.coingeckoId)].join(",")
  //     const resp = await fetch(
  //       `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`
  //     )
  //     return (await resp.json()) as Record<string,{usd:number}>
  //   },
  //
  // })

  useEffect(() => {
    if (!rawTokens || balancesLoading || !viewedAddress) return

    // Async function to fetch min-cawonce for each token and update state
    const updateTokensWithMinCawonce = async () => {
      const updated: TokenData[] = await Promise.all((rawTokens).map(async l1Token => {
        const l2Token = l2TokenData!.find(item => item.tokenId === l1Token.tokenId);
        const onChainCawonce = Number(l2Token!.nextCawonce);

        // Fetch min-cawonce from API to account for scheduled posts
        let effectiveCawonce = onChainCawonce;
        try {
          const minCawonceResponse = await apiFetch(`/api/users/min-cawonce/${Number(l1Token.tokenId)}`);
          if (minCawonceResponse.minSafeCawonce !== null) {
            // Use the higher of on-chain cawonce or min safe cawonce from scheduled posts
            effectiveCawonce = Math.max(onChainCawonce, minCawonceResponse.minSafeCawonce);
            if (effectiveCawonce > onChainCawonce) {
              console.log(`[cawonce] Token ${l1Token.tokenId}: Using min safe cawonce ${effectiveCawonce} (on-chain: ${onChainCawonce}) due to scheduled posts`);
            }
          }
        } catch (err) {
          // If API fails, fall back to on-chain value
          console.warn(`Failed to fetch min-cawonce for token ${l1Token.tokenId}:`, err);
        }

        return {
          tokenId:      Number(l1Token.tokenId),
          username:     l1Token.username,
          withdrawable: l1Token.withdrawable,
          ownerBalance: l1Token.ownerBalance,
          address: viewedAddress!,
          owner: l1Token.owner!,
          stakedAmount:   l2Token!.cawBalance,
          cawonce:      effectiveCawonce,
        }
      }));

      if (rawTokens.length > 0) {
        setTokensForAddress(viewedAddress as Address, updated);
      }
    };

    updateTokensWithMinCawonce();

  }, [rawTokens, l2TokenData, viewedAddress, setTokensForAddress, balancesLoading])

}



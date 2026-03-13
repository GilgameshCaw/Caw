// client/src/services/FrontEnd/src/hooks/useTokenDataUpdate.tsx

import { useEffect, useCallback } from "react"
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

  const { data: rawTokens, isError, error, isLoading, isLoadingError, refetch: refetchL1 } = useReadContract({
    address: CAW_NAMES_ADDRESS,
    chainId: sepolia.id,
    abi: cawNameAbi,
    functionName: "tokens",
    args: [viewedAddress as Address],

    query: {
      enabled: !!viewedAddress,
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


  const { data: l2TokenData, isLoading: balancesLoading, refetch: refetchL2 } = useReadContract({
    address: CAW_NAMES_L2_ADDRESS,
    chainId:      baseSepolia.id,
    abi:          cawNameL2Abi,
    functionName: "getTokens",
    query: {
      enabled: !!rawTokens && rawTokens.length > 0,
    },
    args: [(rawTokens ?? []).map((token) => Number(token.tokenId))],
  })


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

  // Get the active token ID for the current address
  const activeTokenId = activeTokenIdByAddress[viewedAddress?.toLowerCase() as Address]

  // First effect: Update token data from on-chain (without min-cawonce API calls)
  useEffect(() => {
    if (!rawTokens || balancesLoading || !viewedAddress || !l2TokenData) return

    const updated: TokenData[] = rawTokens.map(l1Token => {
      const l2Token = l2TokenData.find(item => item.tokenId === l1Token.tokenId);
      const onChainCawonce = Number(l2Token!.nextCawonce);

      // Get existing token data to preserve any previously fetched min-cawonce
      const existingTokens = tokensByAddress[viewedAddress.toLowerCase() as Address] || [];
      const existingToken = existingTokens.find(t => t.tokenId === Number(l1Token.tokenId));

      // Use existing cawonce if it's higher (from previous min-cawonce fetch), otherwise use on-chain
      const cawonce = existingToken?.cawonce && existingToken.cawonce > onChainCawonce
        ? existingToken.cawonce
        : onChainCawonce;

      return {
        tokenId:      Number(l1Token.tokenId),
        username:     l1Token.username,
        withdrawable: l1Token.withdrawable,
        ownerBalance: l1Token.ownerBalance,
        address: viewedAddress!,
        owner: l1Token.owner!,
        stakedAmount:   l2Token!.cawBalance,
        cawonce,
      }
    });

    if (rawTokens.length > 0) {
      setTokensForAddress(viewedAddress as Address, updated);
    }
  }, [rawTokens, l2TokenData, viewedAddress, setTokensForAddress, balancesLoading])

  const setCawonce = useTokenDataStore(s => s.setCawonce)

  // Second effect: Fetch min-cawonce only for the active token
  useEffect(() => {
    if (!activeTokenId || !l2TokenData) return

    const l2Token = l2TokenData.find(item => item.tokenId === BigInt(activeTokenId));
    if (!l2Token) return;

    const onChainCawonce = Number(l2Token.nextCawonce);

    const fetchMinCawonce = async () => {
      try {
        const minCawonceResponse = await apiFetch(`/api/users/min-cawonce/${activeTokenId}`);
        if (minCawonceResponse.minSafeCawonce !== null) {
          const effectiveCawonce = Math.max(onChainCawonce, minCawonceResponse.minSafeCawonce);
          if (effectiveCawonce > onChainCawonce) {
            console.log(`[cawonce] Token ${activeTokenId}: Using min safe cawonce ${effectiveCawonce} (on-chain: ${onChainCawonce}) due to scheduled posts`);
            setCawonce(activeTokenId, effectiveCawonce);
          }
        }
      } catch (err) {
        console.warn(`Failed to fetch min-cawonce for token ${activeTokenId}:`, err);
      }
    };

    fetchMinCawonce();
  }, [activeTokenId, l2TokenData, setCawonce])

  // Register refetch function in the store so other components can trigger it
  const setRefetchTokenData = useTokenDataStore(s => s.setRefetchTokenData)
  const refetch = useCallback(() => {
    refetchL1()
    refetchL2()
  }, [refetchL1, refetchL2])

  useEffect(() => {
    setRefetchTokenData(refetch)
  }, [refetch, setRefetchTokenData])
}



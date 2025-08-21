// client/src/services/FrontEnd/src/hooks/useTokenDataUpdate.tsx

import { useEffect } from "react"
import { useAccount, useReadContract } from "wagmi"
import { Address } from "viem"
import { baseSepolia, sepolia } from "wagmi/chains"
import { CAW_NAMES_L2_ADDRESS, CAW_NAMES_ADDRESS } from "~/../../../abi/addresses";
import { cawNameAbi, cawNameL2Abi } from "~/../../../abi/generated"
import { useTokenDataStore } from "~/store/tokenDataStore"
import TOKENS from "~/constants/tokens"
// import { useQuery } from "@tanstack/react-query"
import { TokenData } from "~/types";

interface RawToken {
  tokenId:       bigint
  username:      string
  owner:         Address
  ownerBalance:  bigint
  withdrawable:  bigint
}

export default function useTokenDataUpdate() {
  const { address } = useAccount()
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const setTokensForAddress = useTokenDataStore(s => s.setTokensForAddress)
  const tokensByAddress = useTokenDataStore(s => s.tokensByAddress)

  const setActiveTokenId = useTokenDataStore(s => s.setActiveTokenId)
  const setLastAddress = useTokenDataStore(s => s.setLastAddress)
  const lastAddress = useTokenDataStore(s => s.lastAddress)

  const viewedAddress = (address ?? lastAddress) as Address | undefined
  console.log("has address?", !!address, address ?? null, "viewedAddress:", viewedAddress ?? null)

  const { data: rawTokens, isError, error, isLoading, isLoadingError } = useReadContract({
    address: CAW_NAMES_ADDRESS,
    chainId: sepolia.id,
    abi: cawNameAbi,
    functionName: "tokens",
    args: [viewedAddress as Address],

    query: {
      enabled: !!viewedAddress
    }
  })


  if (viewedAddress && rawTokens && rawTokens.length > 0 && activeTokenId === undefined)
    setActiveTokenId(rawTokens[0].tokenId)

  // only update lastAddress when a wallet is actually connected
  if (!!address && rawTokens && rawTokens.length > 0)
    setLastAddress(address)

  console.log("TOKEN DATA FROM L1:", rawTokens, isError, error)

  const { data: l2TokenData, isLoading: balancesLoading  } = useReadContract({
    address: CAW_NAMES_L2_ADDRESS,
    chainId:      baseSepolia.id,
    abi:          cawNameL2Abi,
    functionName: "getTokens",
    query: {
      enabled: !!rawTokens && rawTokens.length > 0,
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

    const updated: TokenData[] = (rawTokens).map(l1Token => {
      // const usdPrice = priceMap[meta.coingeckoId]?.usd ?? 0
      const l2Token = l2TokenData!.find(item => item.tokenId === l1Token.tokenId);

      return {
        tokenId:      Number(l1Token.tokenId),
        username:     l1Token.username,
        withdrawable: l1Token.withdrawable,
        ownerBalance: l1Token.ownerBalance,
        address: viewedAddress!,
        owner: l1Token.owner!,
        stakedAmount:   l2Token!.cawBalance,
        cawonce:      Number(l2Token!.nextCawonce),
      }
    })

    if (rawTokens.length > 0)
      setTokensForAddress(viewedAddress as Address, updated)

  }, [rawTokens, l2TokenData, viewedAddress, setTokensForAddress, balancesLoading])

}



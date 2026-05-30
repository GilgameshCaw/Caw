// client/src/services/FrontEnd/src/hooks/useTokenDataUpdate.tsx

import { useEffect, useCallback, useMemo } from "react"
import { useAccount, useReadContract, useReadContracts } from "wagmi"
import { Address, erc20Abi } from "viem"
import { chains } from "~/config/chains"
import { CAW_NAMES_L2_ADDRESS, CAW_NAMES_ADDRESS, CAW_ADDRESS } from "~/../../../abi/addresses";
import { cawProfileAbi, cawProfileL2Abi } from "~/../../../abi/generated"
import { useTokenDataStore } from "~/store/tokenDataStore"
import { TokenData } from "~/types";
import { apiFetch } from "~/api/client";

// ---------------------------------------------------------------------------
// V2 CawProfile dropped the `tokens(address)` convenience view to fit under
// EIP-170. We reconstruct equivalent data from ERC-721Enumerable primitives:
//   L1: balanceOf → tokenOfOwnerByIndex[]  →  withdrawable[]+ownerOf[] per token
//   L1: CAW ERC-20 balanceOf(owner)        →  ownerBalance
//   L2: getTokens([tokenIds])              →  username, cawBalance, nextCawonce
// ---------------------------------------------------------------------------

// ---- per-address helpers --------------------------------------------------

function useAddressTokenIds(address: Address | undefined, enabled: boolean) {
  const { data: balanceRaw } = useReadContract({
    address: CAW_NAMES_ADDRESS,
    chainId: chains.l1.chainId,
    abi: cawProfileAbi,
    functionName: "balanceOf",
    args: [address as Address],
    query: { enabled: enabled && !!address },
  })
  const tokenCount = balanceRaw !== undefined ? Number(balanceRaw) : 0

  const indexCalls = useMemo(
    () =>
      Array.from({ length: tokenCount }, (_, i) => ({
        address: CAW_NAMES_ADDRESS as Address,
        abi: cawProfileAbi,
        functionName: "tokenOfOwnerByIndex" as const,
        args: [address as Address, BigInt(i)] as const,
        chainId: chains.l1.chainId,
      })),
    [tokenCount, address],
  )

  const { data: indexResults } = useReadContracts({
    contracts: indexCalls,
    query: { enabled: enabled && !!address && tokenCount > 0 },
  })

  const tokenIds: number[] = useMemo(() => {
    if (!indexResults) return []
    return indexResults
      .map(r => (r.status === "success" && r.result !== undefined ? Number(r.result) : null))
      .filter((id): id is number => id !== null)
  }, [indexResults])

  return { tokenIds, tokenCount }
}

function useAddressTokenDetails(
  address: Address | undefined,
  tokenIds: number[],
  enabled: boolean,
) {
  // ---- L1: withdrawable + ownerOf per token --------------------------------
  const l1Calls = useMemo(
    () =>
      tokenIds.flatMap(tid => [
        {
          address: CAW_NAMES_ADDRESS as Address,
          abi: cawProfileAbi,
          functionName: "withdrawable" as const,
          // withdrawable(uint32): viem maps uint32 to number
          args: [tid] as const,
          chainId: chains.l1.chainId,
        },
        {
          address: CAW_NAMES_ADDRESS as Address,
          abi: cawProfileAbi,
          functionName: "ownerOf" as const,
          // ownerOf(uint256): viem maps uint256 to bigint
          args: [BigInt(tid)] as const,
          chainId: chains.l1.chainId,
        },
      ]),
    [tokenIds],
  )

  const { data: l1Results, isLoading: l1Loading } = useReadContracts({
    contracts: l1Calls,
    query: { enabled: enabled && !!address && tokenIds.length > 0 },
  })

  // ---- L1: owner's CAW ERC-20 balance (ownerBalance) ----------------------
  const { data: ownerBalanceRaw } = useReadContract({
    address: CAW_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address as Address],
    chainId: chains.l1.chainId,
    query: { enabled: enabled && !!address },
  })

  // ---- L2: username + cawBalance + nextCawonce -----------------------------
  // getTokens(uint32[]): viem maps uint32[] to number[]
  const { data: l2TokenData, isLoading: l2Loading, refetch: refetchL2 } = useReadContract({
    address: CAW_NAMES_L2_ADDRESS,
    chainId: chains.l2.chainId,
    abi: cawProfileL2Abi,
    functionName: "getTokens",
    args: [tokenIds],
    query: { enabled: enabled && !!address && tokenIds.length > 0 },
  })

  // ---- Assemble l1 per-token maps -----------------------------------------
  const withdrawableMap = useMemo(() => {
    const m = new Map<number, bigint>()
    if (!l1Results) return m
    tokenIds.forEach((tid, i) => {
      const r = l1Results[i * 2]
      if (r?.status === "success") m.set(tid, r.result as bigint)
    })
    return m
  }, [l1Results, tokenIds])

  const ownerOfMap = useMemo(() => {
    const m = new Map<number, Address>()
    if (!l1Results) return m
    tokenIds.forEach((tid, i) => {
      const r = l1Results[i * 2 + 1]
      if (r?.status === "success") m.set(tid, r.result as Address)
    })
    return m
  }, [l1Results, tokenIds])

  const isLoading = l1Loading || l2Loading

  return {
    withdrawableMap,
    ownerOfMap,
    ownerBalance: ownerBalanceRaw ?? 0n,
    l2TokenData,
    isLoading,
    refetchL2,
  }
}

// ---- main hook -----------------------------------------------------------

export default function useTokenDataUpdate() {
  const { address } = useAccount()
  const setTokensForAddress = useTokenDataStore(s => s.setTokensForAddress)
  const tokensByAddress = useTokenDataStore(s => s.tokensByAddress)
  const activeTokenIdByAddress = useTokenDataStore(s => s.activeTokenIdByAddress)
  const setActiveTokenIdForAddress = useTokenDataStore(s => s.setActiveTokenIdForAddress)
  const setLastAddress = useTokenDataStore(s => s.setLastAddress)
  const lastAddress = useTokenDataStore(s => s.lastAddress)

  const viewedAddress = ((lastAddress ?? address)?.toLowerCase()) as Address | undefined
  const connectedAddress = address?.toLowerCase() as Address | undefined
  const needsConnectedFetch = !!connectedAddress && connectedAddress !== viewedAddress

  // ---- tokenIds -----------------------------------------------------------
  const { tokenIds: viewedTokenIds, tokenCount: viewedTokenCount } = useAddressTokenIds(
    viewedAddress,
    !!viewedAddress,
  )
  const { tokenIds: connectedTokenIds } = useAddressTokenIds(
    connectedAddress,
    needsConnectedFetch,
  )

  // ---- per-token details --------------------------------------------------
  const {
    withdrawableMap: viewedWithdrawableMap,
    ownerOfMap: viewedOwnerOfMap,
    ownerBalance: viewedOwnerBalance,
    l2TokenData: viewedL2TokenData,
    isLoading: viewedLoading,
    refetchL2: refetchViewedL2,
  } = useAddressTokenDetails(viewedAddress, viewedTokenIds, !!viewedAddress)

  const {
    withdrawableMap: connectedWithdrawableMap,
    ownerOfMap: connectedOwnerOfMap,
    ownerBalance: connectedOwnerBalance,
    l2TokenData: connectedL2TokenData,
    isLoading: connectedLoading,
    refetchL2: refetchConnectedL2,
  } = useAddressTokenDetails(connectedAddress, connectedTokenIds, needsConnectedFetch)

  // ---- Set active token on first load -------------------------------------
  if (viewedAddress && viewedTokenIds.length > 0) {
    const activeTokenIdForAddress = activeTokenIdByAddress[viewedAddress]
    if (activeTokenIdForAddress === undefined) {
      setActiveTokenIdForAddress(viewedAddress, viewedTokenIds[0])
    }
  }

  // Set lastAddress on initial wallet connect
  if (!!address && viewedTokenIds.length > 0 && !lastAddress) {
    setLastAddress(address.toLowerCase())
  }

  // Marketplace-buy recovery: viewed wallet has no tokens but connected wallet does
  if (
    needsConnectedFetch &&
    connectedAddress &&
    connectedTokenIds.length > 0 &&
    viewedTokenCount === 0 &&
    lastAddress?.toLowerCase() !== connectedAddress
  ) {
    setLastAddress(connectedAddress)
  }

  // ---- Build TokenData from viewed address --------------------------------
  const activeTokenId = activeTokenIdByAddress[viewedAddress?.toLowerCase() as Address]

  useEffect(() => {
    if (!viewedAddress || viewedLoading || !viewedL2TokenData) return
    if (viewedTokenIds.length === 0) return

    const updated: TokenData[] = viewedTokenIds.map(tid => {
      const l2Token = viewedL2TokenData.find(item => Number(item.tokenId) === tid)
      const onChainCawonce = l2Token ? Number(l2Token.nextCawonce) : 0

      const existingTokens = tokensByAddress[viewedAddress.toLowerCase() as Address] || []
      const existingToken = existingTokens.find(t => t.tokenId === tid)
      const cawonce =
        existingToken?.cawonce && existingToken.cawonce > onChainCawonce
          ? existingToken.cawonce
          : onChainCawonce

      return {
        tokenId: tid,
        username: l2Token?.username ?? "",
        withdrawable: viewedWithdrawableMap.get(tid) ?? 0n,
        ownerBalance: viewedOwnerBalance,
        address: viewedAddress,
        owner: viewedOwnerOfMap.get(tid) ?? viewedAddress,
        stakedAmount: l2Token?.cawBalance ?? 0n,
        cawonce,
      }
    })

    setTokensForAddress(viewedAddress as Address, updated)
  }, [viewedTokenIds, viewedL2TokenData, viewedAddress, viewedLoading, viewedWithdrawableMap, viewedOwnerOfMap, viewedOwnerBalance, setTokensForAddress])

  // ---- Build TokenData from connected address (when differs) --------------
  useEffect(() => {
    if (!needsConnectedFetch || !connectedAddress || connectedLoading || !connectedL2TokenData) return
    if (connectedTokenIds.length === 0) return

    const updated: TokenData[] = connectedTokenIds.map(tid => {
      const l2Token = connectedL2TokenData.find(item => Number(item.tokenId) === tid)
      const onChainCawonce = l2Token ? Number(l2Token.nextCawonce) : 0

      const existingTokens = tokensByAddress[connectedAddress as Address] || []
      const existingToken = existingTokens.find(t => t.tokenId === tid)
      const cawonce =
        existingToken?.cawonce && existingToken.cawonce > onChainCawonce
          ? existingToken.cawonce
          : onChainCawonce

      return {
        tokenId: tid,
        username: l2Token?.username ?? "",
        withdrawable: connectedWithdrawableMap.get(tid) ?? 0n,
        ownerBalance: connectedOwnerBalance,
        address: connectedAddress,
        owner: connectedOwnerOfMap.get(tid) ?? connectedAddress,
        stakedAmount: l2Token?.cawBalance ?? 0n,
        cawonce,
      }
    })

    setTokensForAddress(connectedAddress as Address, updated)
  }, [connectedTokenIds, connectedL2TokenData, connectedAddress, needsConnectedFetch, connectedLoading, connectedWithdrawableMap, connectedOwnerOfMap, connectedOwnerBalance, setTokensForAddress])

  // ---- min-cawonce fetch for active token ---------------------------------
  const setCawonce = useTokenDataStore(s => s.setCawonce)

  useEffect(() => {
    if (!activeTokenId || !viewedL2TokenData) return

    const l2Token = viewedL2TokenData.find(item => Number(item.tokenId) === activeTokenId)
    if (!l2Token) return

    const onChainCawonce = Number(l2Token.nextCawonce)

    const fetchMinCawonce = async () => {
      try {
        const minCawonceResponse = await apiFetch(`/api/users/min-cawonce/${activeTokenId}`)
        if (minCawonceResponse.minSafeCawonce !== null) {
          const effectiveCawonce = Math.max(onChainCawonce, minCawonceResponse.minSafeCawonce)
          if (effectiveCawonce > onChainCawonce) {
            console.log(`[cawonce] Token ${activeTokenId}: Using min safe cawonce ${effectiveCawonce} (on-chain: ${onChainCawonce}) due to scheduled posts`)
            setCawonce(activeTokenId, effectiveCawonce)
          }
        }
      } catch (err) {
        console.warn(`Failed to fetch min-cawonce for token ${activeTokenId}:`, err)
      }
    }

    fetchMinCawonce()
  }, [activeTokenId, viewedL2TokenData, setCawonce])

  // ---- Register refetch in store ------------------------------------------
  const setRefetchTokenData = useTokenDataStore(s => s.setRefetchTokenData)

  // We don't have direct refetch handles for the enumerable calls; wagmi will
  // invalidate them automatically on block updates. Expose a no-op-safe refetch
  // for the L2 getTokens calls (the most latency-sensitive path).
  const refetch = useCallback(() => {
    refetchViewedL2()
    if (needsConnectedFetch) {
      refetchConnectedL2()
    }
  }, [refetchViewedL2, refetchConnectedL2, needsConnectedFetch])

  useEffect(() => {
    setRefetchTokenData(refetch)
  }, [refetch, setRefetchTokenData])
}

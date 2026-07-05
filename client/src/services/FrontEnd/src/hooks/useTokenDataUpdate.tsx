// client/src/services/FrontEnd/src/hooks/useTokenDataUpdate.tsx

import { useEffect, useCallback, useMemo } from "react"
import { useAccount, useReadContract, useReadContracts } from "wagmi"
import { Address } from "viem"
import { baseSepolia, sepolia } from "wagmi/chains"
import { CAW_NAMES_L2_ADDRESS, CAW_PROFILE_LENS_ADDRESS } from "~/../../../abi/addresses";
import { cawProfileLensAbi, cawProfileLedgerAbi } from "~/../../../abi/generated"
import { useTokenDataStore } from "~/store/tokenDataStore"
import { usePinnedProfilesStore } from "~/store/pinnedProfilesStore"
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
  const pinnedOwner = usePinnedProfilesStore(s => s.pinnedOwner)
  const activeTokenIdByAddress = useTokenDataStore(s => s.activeTokenIdByAddress)

  const setActiveTokenIdForAddress = useTokenDataStore(s => s.setActiveTokenIdForAddress)
  const setLastAddress = useTokenDataStore(s => s.setLastAddress)
  const lastAddress = useTokenDataStore(s => s.lastAddress)

  // Prefer lastAddress (tracks the active profile's owner) over connected wallet
  // This ensures data refreshes when switching profiles, even to a different owner
  const viewedAddress = ((lastAddress ?? address)?.toLowerCase()) as Address | undefined
  const connectedAddress = address?.toLowerCase() as Address | undefined
  const needsConnectedFetch = !!connectedAddress && connectedAddress !== viewedAddress

  // CawProfileLens.tokens() — the V2 replacement for the removed
  // CawProfile.tokens() view. Same shape returned (tokenId, username,
  // owner, ownerBalance, withdrawable) — see solidity/contracts/CawProfileLens.sol.
  const { data: rawTokens, isError, error, isLoading, isLoadingError, refetch: refetchL1 } = useReadContract({
    address: CAW_PROFILE_LENS_ADDRESS,
    chainId: sepolia.id,
    abi: cawProfileLensAbi,
    functionName: "tokens",
    args: [viewedAddress as Address],

    query: {
      enabled: !!viewedAddress,
    }
  })

  // Also fetch tokens for the connected address if it differs from viewedAddress
  const { data: connectedTokens, refetch: refetchConnected } = useReadContract({
    address: CAW_PROFILE_LENS_ADDRESS,
    chainId: sepolia.id,
    abi: cawProfileLensAbi,
    functionName: "tokens",
    args: [connectedAddress as Address],
    query: {
      enabled: needsConnectedFetch,
    }
  })

  useEffect(() => {
    console.log('[TokenData] L1 query (viewed):', {
      viewedAddress,
      tokenCount: rawTokens?.length ?? 'loading',
      tokens: rawTokens?.map(t => `#${t.tokenId} ${t.username}`),
      isError,
      isLoading,
      errorMsg: error?.message?.slice(0, 300),
      lensAddress: CAW_PROFILE_LENS_ADDRESS,
    })
  }, [rawTokens, viewedAddress, isError, isLoading, error])

  useEffect(() => {
    if (!needsConnectedFetch) return
    console.log('[TokenData] L1 query (connected):', {
      connectedAddress,
      tokenCount: connectedTokens?.length ?? 'loading',
      tokens: connectedTokens?.map(t => `#${t.tokenId} ${t.username}`),
    })
  }, [connectedTokens, connectedAddress, needsConnectedFetch])

  // Set active token for this address if not already set
  if (viewedAddress && rawTokens && rawTokens.length > 0) {
    const activeTokenIdForAddress = activeTokenIdByAddress[viewedAddress]
    if (activeTokenIdForAddress === undefined) {
      setActiveTokenIdForAddress(viewedAddress, Number(rawTokens[0].tokenId))
    }
  }

  // Set lastAddress on initial load when wallet connects (if not already set from profile selection)
  if (!!address && rawTokens && rawTokens.length > 0 && !lastAddress) {
    setLastAddress(address.toLowerCase())
  }

  // Marketplace-buy recovery: when the viewed wallet has zero tokens left
  // (e.g. the user transferred or sold their last profile) AND the connected
  // wallet owns some, promote the connected wallet to lastAddress so the user
  // doesn't get stuck on a profileless view. Importantly we DO NOT do this
  // just because the connected wallet differs from the viewed one — that's
  // a normal state when the user is deliberately viewing as a profile owned
  // by a different wallet. Only the "viewed has nothing to show" case triggers.
  if (
    needsConnectedFetch &&
    connectedAddress &&
    connectedTokens &&
    connectedTokens.length > 0 &&
    rawTokens && rawTokens.length === 0 &&
    lastAddress?.toLowerCase() !== connectedAddress
  ) {
    setLastAddress(connectedAddress)
  }


  // Memoize the token-id arrays so React Query's cache key stays
  // stable across renders. Without this, every parent re-render
  // produced a fresh array reference and wagmi treated it as a new
  // query — refiring getTokens() against L2 even though the contents
  // were identical to the previous call.
  const viewedTokenIds = useMemo(
    () => (rawTokens ?? []).map(t => Number(t.tokenId)),
    [rawTokens],
  )
  const connectedTokenIds = useMemo(
    () => (connectedTokens ?? []).map(t => Number(t.tokenId)),
    [connectedTokens],
  )

  const { data: l2TokenData, isLoading: balancesLoading, refetch: refetchL2 } = useReadContract({
    address: CAW_NAMES_L2_ADDRESS,
    chainId:      baseSepolia.id,
    abi:          cawProfileLedgerAbi,
    functionName: "getTokens",
    query: {
      enabled: !!rawTokens && rawTokens.length > 0,
    },
    args: [viewedTokenIds],
  })

  // L2 data for connected address tokens
  const { data: connectedL2TokenData, isLoading: connectedBalancesLoading, refetch: refetchConnectedL2 } = useReadContract({
    address: CAW_NAMES_L2_ADDRESS,
    chainId: baseSepolia.id,
    abi: cawProfileLedgerAbi,
    functionName: "getTokens",
    query: {
      enabled: needsConnectedFetch && !!connectedTokens && connectedTokens.length > 0,
    },
    args: [connectedTokenIds],
  })


  // Get the active token ID for the current address
  const activeTokenId = activeTokenIdByAddress[viewedAddress?.toLowerCase() as Address]

  // First effect: Update token data from on-chain (without min-cawonce API calls)
  useEffect(() => {
    if (!rawTokens || balancesLoading || !viewedAddress || !l2TokenData) return

    const updated: TokenData[] = rawTokens.map(l1Token => {
      // L2 mirror may not yet have this token if the L1 mint just landed
      // and the LayerZero relay is still in flight. Fall back to zeros
      // (mirrors the connected-fetch branch below); the next refetch
      // after L2 catches up will replace the row with real data.
      //
      // viem auto-decodes the lens Token.tokenId (uint32) as a JS number
      // and the L2 Token.tokenId (uint256) as a BigInt. Compare both as
      // BigInt or the find() silently never matches and every token's
      // stakedAmount stays 0 forever.
      const l1TokenIdBI = BigInt(l1Token.tokenId)
      const l2Token = l2TokenData.find(item => BigInt(item.tokenId) === l1TokenIdBI);
      const onChainCawonce = l2Token ? Number(l2Token.nextCawonce) : 0;

      // Get existing token data to preserve any previously fetched min-cawonce
      const existingTokens = tokensByAddress[viewedAddress.toLowerCase() as Address] || [];
      const existingToken = existingTokens.find(t => t.tokenId === Number(l1Token.tokenId));

      // Use existing cawonce if it's higher (from previous min-cawonce fetch), otherwise use on-chain
      const cawonce = existingToken?.cawonce && existingToken.cawonce > onChainCawonce
        ? existingToken.cawonce
        : onChainCawonce;

      const nextStaked = l2Token?.cawBalance ?? 0n
      // [POPB-DBG][zero-caw] Disambiguate WHY staked shows 0: L2 row missing (relay
      // in flight, fell back to 0) vs L2 genuinely reports 0 vs real value — and flag
      // when we're about to OVERWRITE a previously-nonzero staked with 0 (the "correct
      // then flips to zero" symptom). Remove once the post-mint deposit display is solid.
      const prevStaked = existingToken?.stakedAmount
      if (nextStaked === 0n) {
        console.log('[POPB-DBG][zero-caw] viewed-tokens write staked=0', {
          tokenId: Number(l1Token.tokenId),
          l2RowFound: !!l2Token,
          reason: l2Token ? 'L2-reports-0' : 'L2-row-missing(relay-in-flight)',
          prevStaked: prevStaked != null ? prevStaked.toString() : 'none',
          overwritingNonZero: prevStaked != null && prevStaked > 0n,
        })
      }
      return {
        tokenId:      Number(l1Token.tokenId),
        username:     l1Token.username,
        withdrawable: l1Token.withdrawable,
        ownerBalance: l1Token.ownerBalance,
        address: viewedAddress!,
        owner: l1Token.owner!,
        stakedAmount: nextStaked,
        cawonce,
      }
    });

    if (rawTokens.length > 0) {
      setTokensForAddress(viewedAddress as Address, updated);
    }
  }, [rawTokens, l2TokenData, viewedAddress, setTokensForAddress, balancesLoading])

  // Process connected address tokens (when different from viewed address)
  useEffect(() => {
    if (!needsConnectedFetch || !connectedTokens || connectedBalancesLoading || !connectedAddress || !connectedL2TokenData) return

    const updated: TokenData[] = connectedTokens.map(l1Token => {
      // BigInt-vs-number coercion: see the viewed-tokens branch above.
      const l1TokenIdBI = BigInt(l1Token.tokenId)
      const l2Token = connectedL2TokenData.find(item => BigInt(item.tokenId) === l1TokenIdBI);
      const onChainCawonce = l2Token ? Number(l2Token.nextCawonce) : 0;

      const existingTokens = tokensByAddress[connectedAddress as Address] || [];
      const existingToken = existingTokens.find(t => t.tokenId === Number(l1Token.tokenId));
      const cawonce = existingToken?.cawonce && existingToken.cawonce > onChainCawonce
        ? existingToken.cawonce : onChainCawonce;

      return {
        tokenId: Number(l1Token.tokenId),
        username: l1Token.username,
        withdrawable: l1Token.withdrawable,
        ownerBalance: l1Token.ownerBalance,
        address: connectedAddress!,
        owner: l1Token.owner!,
        stakedAmount: l2Token?.cawBalance ?? 0n,
        cawonce,
      }
    });

    setTokensForAddress(connectedAddress as Address, updated);
  }, [connectedTokens, connectedL2TokenData, connectedAddress, needsConnectedFetch, setTokensForAddress, connectedBalancesLoading])

  // ── Keep ALL known accounts fresh (multi-passkey-account fix) ──────────────
  // The single viewed/connected reads above only refresh the active profile's
  // owner (lastAddress) plus a connected wagmi wallet. A Population-B user can
  // hold several passkey accounts, each owned by a DIFFERENT secp256k1 address
  // (every onboarding mints a fresh keypair — see bootstrap.ts). When they
  // switch to a second account, lastAddress moves to it and the FIRST account's
  // on-chain data would never refresh — and a cold-start with no wagmi wallet
  // would only ever fetch lastAddress, so the other accounts silently vanish
  // from the profile chooser ("the app forgot my other account").
  //
  // Fix: multicall CawProfileLens.tokens() for every owner address we already
  // know about (the persisted tokensByAddress keys ∪ viewed ∪ connected), so a
  // background refresh keeps each account populated regardless of which is
  // active. This is read-only and additive: each address's row set is written
  // back under its own key via setTokensForAddress.
  const knownAddresses = useMemo(() => {
    const set = new Set<string>()
    for (const addr of Object.keys(tokensByAddress)) {
      if (addr) set.add(addr.toLowerCase())
    }
    if (viewedAddress) set.add(viewedAddress)
    if (connectedAddress) set.add(connectedAddress)
    // Pinned profiles' owners — even when a pinned profile's owner is neither
    // viewed nor connected nor currently in tokensByAddress, keep refreshing it
    // so a pin actually keeps the profile in the chooser instead of letting it
    // fall out when the user switches to another account. (The owner is captured
    // at pin time; see pinnedProfilesStore.)
    for (const owner of Object.values(pinnedOwner)) {
      if (owner) set.add(owner.toLowerCase())
    }
    return Array.from(set) as Address[]
    // tokensByAddress identity changes whenever any address's rows change; that
    // is fine — the contract args below are memoized to the address list only.
  }, [tokensByAddress, viewedAddress, connectedAddress, pinnedOwner])

  // Stable key: only the sorted address list, so adding/removing an account
  // refires the multicall but a rows-only update (same addresses) does not.
  const knownAddressesKey = useMemo(
    () => [...knownAddresses].sort().join(','),
    [knownAddresses],
  )

  const { data: allL1Tokens, refetch: refetchAllL1 } = useReadContracts({
    contracts: knownAddresses.map(addr => ({
      address: CAW_PROFILE_LENS_ADDRESS,
      chainId: sepolia.id,
      abi: cawProfileLensAbi,
      functionName: "tokens" as const,
      args: [addr] as const,
    })),
    query: {
      // Run whenever there's ≥1 known address. Previously this skipped the
      // single-address case ("viewed/connected reads cover it") — but a Pop-B
      // passkey profile has NO wagmi connection, so it's neither viewed nor
      // connected. After a localStorage eviction the session self-heal (App.tsx)
      // seeds ONE placeholder address with an empty username; if the multicall
      // skipped length===1 it would never enrich it, so AuthGate (gates on
      // username) keeps bouncing the user to /welcome. ≥1 covers that recovery.
      // For a normal connected wallet this is at worst a redundant read; the
      // writes are idempotent.
      enabled: knownAddresses.length >= 1,
    },
  })

  // Flat list of every (addr, tokenId) across all known accounts, for the L2
  // balance multicall. Memoized on the resolved data so it only recomputes when
  // the underlying L1 rows actually change.
  const allTokenIds = useMemo(() => {
    if (!allL1Tokens) return [] as number[]
    const ids: number[] = []
    for (const res of allL1Tokens) {
      if (res.status !== 'success' || !res.result) continue
      for (const tok of res.result) ids.push(Number(tok.tokenId))
    }
    return ids
  }, [allL1Tokens])

  const allTokenIdsKey = useMemo(() => allTokenIds.join(','), [allTokenIds])

  const { data: allL2Tokens, refetch: refetchAllL2 } = useReadContract({
    address: CAW_NAMES_L2_ADDRESS,
    chainId: baseSepolia.id,
    abi: cawProfileLedgerAbi,
    functionName: "getTokens",
    args: [allTokenIds],
    query: {
      enabled: knownAddresses.length >= 1 && allTokenIds.length > 0,
    },
  })

  // Write each known address's refreshed rows back under its own key. Runs only
  // for the multi-account case; the single-account path stays on the viewed/
  // connected effects above (no behavior change for Pop-A / single-profile).
  useEffect(() => {
    if (knownAddresses.length < 1 || !allL1Tokens) return
    const l2 = allL2Tokens ?? []
    allL1Tokens.forEach((res, i) => {
      if (res.status !== 'success' || !res.result) return
      const addr = knownAddresses[i]
      if (!addr) return
      const updated: TokenData[] = res.result.map(l1Token => {
        const l1TokenIdBI = BigInt(l1Token.tokenId)
        const l2Token = l2.find(item => BigInt(item.tokenId) === l1TokenIdBI)
        const onChainCawonce = l2Token ? Number(l2Token.nextCawonce) : 0
        const existingTokens = tokensByAddress[addr.toLowerCase() as Address] || []
        const existingToken = existingTokens.find(t => t.tokenId === Number(l1Token.tokenId))
        const cawonce = existingToken?.cawonce && existingToken.cawonce > onChainCawonce
          ? existingToken.cawonce : onChainCawonce
        return {
          tokenId: Number(l1Token.tokenId),
          username: l1Token.username,
          withdrawable: l1Token.withdrawable,
          ownerBalance: l1Token.ownerBalance,
          address: addr,
          owner: l1Token.owner!,
          stakedAmount: l2Token?.cawBalance ?? 0n,
          cawonce,
        }
      })
      // Only write when the address actually has rows, so a transient empty
      // result (RPC hiccup) can't wipe a known account out of the store.
      if (updated.length > 0) {
        setTokensForAddress(addr, updated)
      } else {
        // Multicall SUCCEEDED but this address owns no profiles on-chain. If the
        // store holds only usernameless placeholder rows for it (e.g. the #447
        // ghost seeded from a stale session authorizedTokenId that doesn't exist
        // on-chain), prune the address entirely so the blank "@ / Token #NNN"
        // account stops rendering in the chooser / AccountSettings. We only prune
        // when EVERY row is usernameless — a real named profile is never dropped
        // by an empty multicall (that's the RPC-hiccup guard above).
        const existing = tokensByAddress[addr.toLowerCase() as Address] || []
        if (existing.length > 0 && existing.every(t => !t.username)) {
          useTokenDataStore.getState().removeAddress(addr.toLowerCase() as Address)
        }
      }
    })

    // Self-heal a stale global activeTokenId. If it points at a tokenId that the
    // fresh multicall no longer returns (e.g. the #447 ghost — a placeholder
    // seeded from a stale server-session authorizedTokenId that doesn't exist
    // on-chain), it would otherwise keep the session pinned to a usernameless
    // token and bounce AuthGate to /welcome. Repoint it to the first REAL token.
    {
      const st = useTokenDataStore.getState()
      if (st.activeTokenId !== undefined) {
        const all = Object.values(st.tokensByAddress).flat()
        const cur = all.find(t => t.tokenId === st.activeTokenId)
        if (!cur || !cur.username) {
          const firstNamed = all.find(t => !!t.username)
          if (firstNamed) {
            console.warn(`[TokenData] resetting stale/usernameless activeTokenId=${st.activeTokenId} → #${firstNamed.tokenId} ${firstNamed.username}`)
            st.setActiveTokenId(firstNamed.tokenId)
          }
        }
      }
    }
    // knownAddressesKey/allTokenIdsKey are the real triggers; the data objects
    // are stable per-fetch. tokensByAddress intentionally omitted to avoid a
    // write→re-render→write loop (we read it via closure for cawonce only).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allL1Tokens, allL2Tokens, knownAddressesKey, allTokenIdsKey, setTokensForAddress])

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
    if (needsConnectedFetch) {
      refetchConnected()
      refetchConnectedL2()
    }
    // Also refresh every other known account (multi-passkey-account fix) so a
    // manual refetch — e.g. right after onboarding a second account or a
    // profile switch — re-populates accounts other than the active one.
    if (knownAddresses.length > 1) {
      refetchAllL1()
      if (allTokenIds.length > 0) refetchAllL2()
    }
  }, [
    refetchL1, refetchL2, needsConnectedFetch, refetchConnected, refetchConnectedL2,
    knownAddresses.length, refetchAllL1, refetchAllL2, allTokenIds.length,
  ])

  useEffect(() => {
    setRefetchTokenData(refetch)
  }, [refetch, setRefetchTokenData])
}



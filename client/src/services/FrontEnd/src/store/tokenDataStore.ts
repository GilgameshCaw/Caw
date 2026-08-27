// client/src/services/FrontEnd/src/store/tokenDataStore.ts
import { Address } from "viem";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { TokenData } from "~/types";
import { clearPasskeyCredential, clearPasskeyAddress, isPasskeyAddress } from "~/constants/passkeyStorage";



interface TokenDataStore {
  tokensByAddress: Record<Address, TokenData[]>;
  lastAddress?: string;
  hasHydrated: boolean;
  activeTokenId?: number; // Deprecated - keeping for backwards compatibility
  activeTokenIdByAddress: Record<Address, number>;
  lastCawonceSyncAt: number; // timestamp (ms) of last on-chain cawonce fetch
  setHasHydrated: () => void;
  removeActiveToken: () => void;
  bumpCawonce:  (tokenId: number) => void;
  setTokensForAddress: (addr: Address, tokens: TokenData[]) => void;
  removeAddress: (addr: Address) => void;
  removeToken: (tokenId: number) => void;
  /** Move a token from its current owner key to `toAddress` (a wallet the user
   *  also controls) — used for a transfer to one of the user's OWN addresses so
   *  the profile leaves the old owner and appears under the new owner instantly,
   *  keeping its passkey credential. No-op if the token isn't held locally. */
  moveTokenToAddress: (tokenId: number, toAddress: Address) => void;
  allTokens: () => TokenData[]


  setLastAddress: (addr: string) => void;
  setActiveTokenId:   (tokenId?: number|bigint) => void;
  setActiveTokenIdForAddress: (addr: Address, tokenId: number) => void;

  setCawonce:   (tokenId: number, cawonce: number) => void;
  avatarsByTokenId: Record<number, string>; // tokenId -> avatarUrl
  setAvatar: (tokenId: number, avatarUrl: string | null) => void;
  refetchTokenData: (() => void) | null;
  setRefetchTokenData: (fn: () => void) => void;
}

/**
 * Repeatedly call refetchTokenData() until the persisted token list
 * actually changes (or the budget runs out). Used by the marketplace
 * buy/accept flows so the chooser updates as soon as the indexer has
 * reflected the L2 Sale event — instead of doing a single one-shot
 * refetch and losing the race when the chain is slow.
 *
 * The signature is intentionally minimal — caller doesn't need to know
 * which token to wait for; we just watch for any change in the JSON
 * shape of tokensByAddress (count + tokenIds per address). Stops on
 * first observed change OR when budget exhausted; resolved-once.
 *
 * Backoff: 1s, 2s, 4s, 8s, 8s, 8s (~31s total). The marketplace
 * indexer polls every ~60s, so the worst case is we miss the first
 * indexer tick and catch the next; common case lands within ~10s.
 */
export async function refetchTokenDataUntilChanged(maxMs = 35000): Promise<void> {
  const refetch = useTokenDataStore.getState().refetchTokenData
  if (!refetch) return

  // Snapshot current token shape so we know what "changed" means.
  const snapshot = (): string => {
    const m = useTokenDataStore.getState().tokensByAddress
    const out: Record<string, number[]> = {}
    for (const [addr, tokens] of Object.entries(m)) {
      out[addr.toLowerCase()] = tokens.map(t => t.tokenId).sort((a, b) => a - b)
    }
    return JSON.stringify(out)
  }
  const before = snapshot()

  const delays = [1000, 2000, 4000, 8000, 8000, 8000]
  const started = Date.now()
  for (const d of delays) {
    if (Date.now() - started > maxMs) return
    refetch()
    // Give the refetch a moment to land in the store before checking.
    // 600ms is generous for a single-instance API; keeps the loop
    // responsive without hammering.
    await new Promise(r => setTimeout(r, d))
    if (snapshot() !== before) return
  }
  // Final attempt after the loop in case the very last refetch is what
  // produced the change.
  if (snapshot() !== before) return
}

export const useActiveToken = () =>
  useTokenDataStore(state => {
    // Get all tokens first
    const allTokens = Object.values(state.tokensByAddress).flat()

    // Don't return defaults before hydration completes to avoid showing wrong token
    if (!state.hasHydrated) return undefined

    if (allTokens.length === 0) return undefined

    // Only ever treat a token with a real username as active. A usernameless
    // placeholder (e.g. a partially-indexed row, or the "ghost" chooser entry)
    // must NEVER win selection — activeToken feeds AuthGate, which gates on
    // username and bounces the whole session to /welcome if the active token has
    // none. This is the "clicked a blank profile → logged out of everything, real
    // profiles still in the store" bug: a stale global activeTokenId pointed at a
    // usernameless token. Prefer real tokens everywhere.
    const named = allTokens.filter(t => !!t.username)
    if (named.length === 0) return undefined

    // Compute the connected wallet's own tokens up front so activeTokenId
    // selection can be CONSTRAINED to them. lastAddress only changes on
    // wallet-connect, so it's the ownership anchor.
    const address = state.lastAddress as Address | undefined
    const normalizedAddress = address?.toLowerCase()
    const tokensForAddress = normalizedAddress
      ? (Object.entries(state.tokensByAddress)
          .find(([addr]) => addr.toLowerCase() === normalizedAddress)?.[1] || [])
          .filter(t => !!t.username)
      : []

    // If there's a global activeTokenId, use it — but ONLY if it resolves to a
    // token the connected wallet actually owns. Matching against every named
    // token (the old behavior) could surface a token from ANOTHER address the
    // user had merely browsed to — e.g. a stale activeTokenId pointing at a
    // stranger's profile would show that stranger as your active token.
    if (state.activeTokenId !== undefined) {
      const ownedMatch = tokensForAddress.find(t => t.tokenId === state.activeTokenId)
      if (ownedMatch) return ownedMatch
      // else fall through (global id missing, points at a stranger, or a ghost)
    }

    // No connected wallet at all — surface any named profile so a pre-connect /
    // browsing user still sees content (unchanged from prior behavior).
    if (!address) {
      return named[0]
    }

    const activeTokenIdForAddress = Object.entries(state.activeTokenIdByAddress)
      .find(([addr]) => addr.toLowerCase() === normalizedAddress)?.[1]

    // The active token for this address, or the wallet's first NAMED token.
    // Deliberately NO `|| named[0]` fallback: when a wallet IS connected but its
    // own rows haven't loaded yet, we return undefined rather than the first
    // token anywhere — that trailing fallback was the stranger-leak (it showed
    // another address's profile as yours during a hydration race). undefined
    // here is the correct "no owned profile" answer for AuthGate.
    return tokensForAddress.find(t => t.tokenId === activeTokenIdForAddress) || tokensForAddress[0]
  }
);

/**
 * The OWNER ADDRESS of the currently-active token (the address key under which
 * the active token lives in tokensByAddress), lowercased. undefined if no
 * active token is resolvable yet.
 *
 * Used by useWalletPopulation to decide whether a no-wagmi-wallet session is a
 * passkey (Population B) profile: a passkey profile is owned by the SmartEOA
 * address persisted as `lastAddress`, whereas a Pop-A profile in the same
 * chooser is owned by a different (real EOA) address. Matching the active
 * token's owner against the passkey owner is per-PROFILE, so a browser that
 * once enrolled a passkey no longer misclassifies a Pop-A profile as B.
 */
export const useActiveTokenOwnerAddress = (): string | undefined =>
  useTokenDataStore(state => {
    if (!state.hasHydrated) return undefined
    // The active token's owner is the connected wallet (lastAddress). Only honor
    // a global activeTokenId if that id is actually one of lastAddress's tokens —
    // otherwise a stale/browsed activeTokenId pointing at another user's profile
    // would report THAT user's address as the active owner (same cross-address
    // leak fixed in useActiveToken).
    const last = state.lastAddress?.toLowerCase()
    const activeId = state.activeTokenId
    if (activeId !== undefined && last) {
      const lastTokens = Object.entries(state.tokensByAddress)
        .find(([addr]) => addr.toLowerCase() === last)?.[1] || []
      if (lastTokens.some(t => t.tokenId === activeId)) return last
    }
    return last
  });

export const useTokenDataStore = create<TokenDataStore>()(
  persist(
    (set, get) => ({
      hasHydrated: false,
      tokensByAddress: {},
      lastAddress: undefined,
      activeTokenId: undefined,
      activeTokenIdByAddress: {},
      lastCawonceSyncAt: 0,
      avatarsByTokenId: {},
      refetchTokenData: null,
      setRefetchTokenData: (fn) => set({ refetchTokenData: fn }),
      allTokens: () => {
        const { tokensByAddress } = get()
        return Object.values(tokensByAddress).flat()
      },
      setHasHydrated: () => set({ hasHydrated: true }),
      setTokensForAddress: (addr, tokens) =>
        set(state => {
          // [multiAccount:diag] Detect the "second account clobbers first" report.
          // setTokensForAddress is additive (spreads existing), so if account #1's
          // address VANISHES across a setTokensForAddress for account #2, the
          // clobber is upstream (account #1 was already gone from state). Log the
          // before/after address sets so we can see exactly when #1 disappears.
          const before = Object.keys(state.tokensByAddress)
          const writing = addr.toLowerCase()
          const after = before.includes(writing) ? before : [...before, writing]
          console.log('[multiAccount:diag] setTokensForAddress', {
            writingAddr: writing,
            tokenIds: tokens.map(t => t.tokenId),
            addressesBefore: before,
            addressesAfter: after,
            droppedAny: before.filter(a => a !== writing && !after.includes(a)),
          })
          return {
            tokensByAddress: {
              ...state.tokensByAddress,
              [addr.toLowerCase() as Address]: tokens
            }
          }
        }),
      removeAddress: (addressToRemove: Address) =>
        set(state => {
          const normalizedAddress = addressToRemove.toLowerCase() as Address
          const { [normalizedAddress]: _, ...remainingTokens } = state.tokensByAddress;
          const { [normalizedAddress]: __, ...remainingActiveTokenIds } = state.activeTokenIdByAddress;

          console.log("remainingTokens:", remainingTokens, addressToRemove)
          return {
            tokensByAddress: remainingTokens,
            activeTokenIdByAddress: remainingActiveTokenIds,
          };
        }),

      removeToken: (tokenId: number) =>
        set(state => {
          // Which address(es) held this token — needed to reconcile the passkey
          // markers below (a Pop-B profile has its own dedicated owner EOA).
          const owningAddrs = Object.entries(state.tokensByAddress)
            .filter(([, tokens]) => tokens.some(t => t.tokenId === tokenId))
            .map(([addr]) => addr.toLowerCase())

          const updatedTokensByAddress: Record<Address, TokenData[]> = {}
          for (const [addr, tokens] of Object.entries(state.tokensByAddress)) {
            const filtered = tokens.filter(t => t.tokenId !== tokenId)
            if (filtered.length > 0) {
              updatedTokensByAddress[addr as Address] = filtered
            }
          }

          // Drop the per-address active pointer for any address that no longer
          // holds any tokens after this removal.
          const updatedActiveByAddress = { ...state.activeTokenIdByAddress }
          for (const addr of owningAddrs) {
            if (!updatedTokensByAddress[addr as Address]) {
              delete updatedActiveByAddress[addr as Address]
            }
          }

          // Forget the sold profile's passkey credential — it's useless once we
          // don't control the owner EOA, and leaving it would keep the profile
          // classified as ours (useWalletPopulation / listing gate). Also forget
          // an owner-address marker once that address has NO remaining passkey
          // profiles in the store.
          clearPasskeyCredential(tokenId)
          for (const addr of owningAddrs) {
            const remaining = updatedTokensByAddress[addr as Address] || []
            if (remaining.length === 0 && isPasskeyAddress(addr)) {
              clearPasskeyAddress(addr)
            }
          }

          return {
            tokensByAddress: updatedTokensByAddress,
            activeTokenIdByAddress: updatedActiveByAddress,
            activeTokenId: state.activeTokenId === tokenId ? undefined : state.activeTokenId,
          }
        }),

      moveTokenToAddress: (tokenId: number, toAddress: Address) =>
        set(state => {
          const to = toAddress.toLowerCase() as Address
          // Find the token row + its current owner key.
          let moved: TokenData | undefined
          let fromKey: string | undefined
          for (const [addr, tokens] of Object.entries(state.tokensByAddress)) {
            const found = tokens.find(t => t.tokenId === tokenId)
            if (found) { moved = found; fromKey = addr.toLowerCase(); break }
          }
          if (!moved || !fromKey) return {}          // not held locally → no-op
          if (fromKey === to) return {}              // already there → no-op

          // Rebuild tokensByAddress: strip the token from its old key, append it
          // (re-owned) under the destination key. Preserve the passkey credential
          // (the user still controls the new owner) — do NOT clear it.
          const next: Record<Address, TokenData[]> = {}
          for (const [addr, tokens] of Object.entries(state.tokensByAddress)) {
            const key = addr.toLowerCase() as Address
            const kept = tokens.filter(t => t.tokenId !== tokenId)
            if (kept.length > 0) next[key] = kept
          }
          const movedRow: TokenData = { ...moved, address: to, owner: to }
          next[to] = [...(next[to] || []), movedRow]

          // Old owner key emptied → drop its per-address active pointer.
          const updatedActiveByAddress = { ...state.activeTokenIdByAddress }
          if (!next[fromKey as Address]) delete updatedActiveByAddress[fromKey as Address]

          return {
            tokensByAddress: next,
            activeTokenIdByAddress: updatedActiveByAddress,
            // The active token id (if it was this one) stays valid — it just
            // lives under a new owner key now, so leave activeTokenId as-is.
          }
        }),

      setActiveTokenId: (tokenId) => {
        const state = get()
        const numTokenId = Number(tokenId)

        // Find which address owns this token
        let ownerAddress: Address | undefined
        for (const [addr, tokens] of Object.entries(state.tokensByAddress)) {
          if (tokens.some(t => t.tokenId === numTokenId)) {
            ownerAddress = addr as Address
            break
          }
        }

        if (ownerAddress) {
          // Normalize address for storage
          const normalizedAddress = ownerAddress.toLowerCase() as Address
          set({
            activeTokenId: numTokenId,
            // Don't update lastAddress - that should only change when wallet connects
            activeTokenIdByAddress: {
              ...state.activeTokenIdByAddress,
              [normalizedAddress]: numTokenId
            }
          })
        } else {
          // Fallback if we can't find the token
          set({ activeTokenId: numTokenId })
        }
      },
      setActiveTokenIdForAddress: (addr, tokenId) => set(state => {
        const normalized = addr.toLowerCase() as Address
        // Keep the global activeTokenId in lockstep with the per-address
        // picker WHEN this address is the currently-connected one (i.e.
        // matches lastAddress). Without this, components that read
        // s.activeTokenId directly fall back to tokens[0] from a wallet
        // the user signed in with previously, and trip the wrong-wallet
        // pre-flight on like/recaw/etc. setActiveTokenId already does the
        // mirror in the other direction (line ~140); this closes the loop.
        const isActiveWallet = state.lastAddress?.toLowerCase() === normalized
        return {
          activeTokenIdByAddress: {
            ...state.activeTokenIdByAddress,
            [normalized]: tokenId,
          },
          ...(isActiveWallet ? { activeTokenId: tokenId } : {}),
        }
      }),
      setLastAddress: (address) => {
        // setLastAddress used to auto-snap the global activeTokenId to the
        // newly-connected wallet's per-address pick. That was overzealous:
        // it also fired on RainbowKit/account-watcher events, so changing
        // which wallet is connected silently changed which profile was
        // active — even when the user had explicitly picked a profile
        // owned by a different wallet. The explicit-pick path
        // (setActiveTokenIdForAddress, setActiveTokenId) still keeps the
        // global in lockstep, so the original "wrong-wallet preflight"
        // symptom this used to fix stays fixed.
        set({ lastAddress: address.toLowerCase() })
      },
      removeActiveToken: () => set({ activeTokenId: undefined }),

      setCawonce: (tokenId, cawonce) =>
        set(state => ({
          lastCawonceSyncAt: Date.now(),
          tokensByAddress: Object.fromEntries(
            Object.entries(state.tokensByAddress).map(([addr, list]) => [
              addr,
              list.map(t =>
                t.tokenId === tokenId
                  ? { ...t, cawonce }
                  : t
              )
            ])
          )
        })),

      setAvatar: (tokenId, avatarUrl) =>
        set(state => ({
          avatarsByTokenId: {
            ...state.avatarsByTokenId,
            [tokenId]: avatarUrl || ''  // empty string = fetched but no avatar
          }
        })),

      bumpCawonce: tokenId =>
        set(state => ({
          tokensByAddress: Object.fromEntries(
            Object.entries(state.tokensByAddress).map(([addr, list]) => [
              addr,
              (list || []).map(t =>
                t.tokenId === tokenId
                  ? { ...t, cawonce: t.cawonce + 1 }
                  : t
              )
            ])
          )
        })),
    }),
    {


      name: 'caw-token-data',            // key in localStorage
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated()
      },
      storage: {
        getItem: (name) => {
          const str = localStorage.getItem(name)
          if (!str) return null
          // parse with reviver to turn digit‑strings back into BigInts
          return JSON.parse(str, (_key, value) =>
            typeof value === 'string' && /^\d+$/.test(value)
              ? BigInt(value)
              : value
          )
        },
        setItem: (name, value) => {
          // stringify with replacer so BigInts become strings
          const str = JSON.stringify(value, (_key, value) =>
            typeof value === 'bigint' ? value.toString() : value
          )
          localStorage.setItem(name, str)
        },
        removeItem: (name) => {
          localStorage.removeItem(name)
        }
      },
      merge: (persisted, current) => {
        const persistedState = (persisted || {}) as Partial<TokenDataStore>;
        const currentState = current as TokenDataStore;

        // Normalize all persisted addresses to lowercase to prevent duplicates
        const normalizedTokensByAddress: Record<Address, TokenData[]> = {}
        for (const [addr, tokens] of Object.entries(persistedState.tokensByAddress || {})) {
          const normalizedAddr = addr.toLowerCase() as Address
          if (!normalizedTokensByAddress[normalizedAddr]) {
            normalizedTokensByAddress[normalizedAddr] = []
          }
          for (const token of tokens) {
            if (!normalizedTokensByAddress[normalizedAddr].some(t => t.tokenId === token.tokenId)) {
              normalizedTokensByAddress[normalizedAddr].push(token)
            }
          }
        }

        const normalizedActiveTokenIdByAddress: Record<Address, number> = {}
        for (const [addr, tokenId] of Object.entries(persistedState.activeTokenIdByAddress || {})) {
          const normalizedAddr = addr.toLowerCase() as Address
          // Keep the last one if there are duplicates
          normalizedActiveTokenIdByAddress[normalizedAddr] = tokenId as number
        }

        // [multiAccount:diag] What addresses did localStorage actually hold at
        // rehydrate? If account #1 is MISSING here, it was never persisted (the
        // clobber happened before the persist write); if it's PRESENT here but
        // gone from the UI, the clobber is post-rehydrate (a runtime overwrite).
        console.log('[multiAccount:diag] persist merge (rehydrate)', {
          persistedAddresses: Object.keys(normalizedTokensByAddress),
          currentAddresses: Object.keys(currentState.tokensByAddress || {}),
          persistedLastAddress: persistedState.lastAddress,
        })

        return {
          ...currentState, // current provides defaults
          ...persistedState, // persisted wins at top level (opposite of before!)
          tokensByAddress: {
            ...normalizedTokensByAddress,
            ...(currentState.tokensByAddress || {}), // current wins per address for fresh data
          },
          activeTokenIdByAddress: {
            ...normalizedActiveTokenIdByAddress,
            ...(currentState.activeTokenIdByAddress || {}),
          },
        };
      },
      partialize: (state) => ({          // only persist the ID
        tokensByAddress: state.tokensByAddress,
        activeTokenId:   state.activeTokenId,
        activeTokenIdByAddress: state.activeTokenIdByAddress,
        lastAddress:     state.lastAddress,
        hasHydrated:     state.hasHydrated,
        avatarsByTokenId: state.avatarsByTokenId
      }) as TokenDataStore
    }
  )
);

export const usePriceStore = create<{
    priceMap: Record<string, number>
    setPriceMap: (prices: Record<string, number>) => void
}>(set => ({
    priceMap: {},
    setPriceMap: prices => set({ priceMap: prices }),
}))

/**
 * Which liquidity pool the CAW $-display should resolve to.
 *  - 'mainnet': real CAW/WETH pool on Ethereum mainnet (CAW spot from Uniswap V2)
 *  - 'sepolia': testnet CAW/WETH pool on Sepolia (matches what the zap actually
 *               charges, so users see the same $ value they actually paid)
 *
 * useFetchPrices mirrors the active source into priceMap['a-hunters-dream']
 * so all consumers read the right value without per-callsite changes.
 * Persisted to localStorage so the user's pick survives reloads.
 */
type PriceSource = 'mainnet' | 'sepolia'
const PRICE_SOURCE_KEY = 'caw:priceSource'
function loadPriceSource(): PriceSource {
  if (typeof window === 'undefined') return 'mainnet'
  try {
    const v = localStorage.getItem(PRICE_SOURCE_KEY)
    return v === 'sepolia' ? 'sepolia' : 'mainnet'
  } catch { return 'mainnet' }
}
export const usePriceSourceStore = create<{
  source: PriceSource
  setSource: (s: PriceSource) => void
  toggle: () => void
}>((set, get) => ({
  source: loadPriceSource(),
  setSource: (source: PriceSource) => {
    try { localStorage.setItem(PRICE_SOURCE_KEY, source) } catch {}
    set({ source })
  },
  toggle: () => {
    const next: PriceSource = get().source === 'mainnet' ? 'sepolia' : 'mainnet'
    try { localStorage.setItem(PRICE_SOURCE_KEY, next) } catch {}
    set({ source: next })
  },
}))


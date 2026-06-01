// client/src/services/FrontEnd/src/store/tokenDataStore.ts
import { Address } from "viem";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { TokenData } from "~/types";



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

    // If there's a global activeTokenId, use that (allows viewing tokens from any address)
    if (state.activeTokenId !== undefined) {
      const token = allTokens.find(t => t.tokenId === state.activeTokenId)
      if (token) return token
    }

    // Fallback: Try to use lastAddress to find a default token
    const address = state.lastAddress as Address | undefined
    if (!address) {
      return allTokens[0]
    }

    // Normalize address comparison (case-insensitive)
    const normalizedAddress = address.toLowerCase()
    const tokensForAddress = Object.entries(state.tokensByAddress)
      .find(([addr]) => addr.toLowerCase() === normalizedAddress)?.[1] || []

    const activeTokenIdForAddress = Object.entries(state.activeTokenIdByAddress)
      .find(([addr]) => addr.toLowerCase() === normalizedAddress)?.[1]

    // Find the active token for this address, or default to first token
    return tokensForAddress.find(t => t.tokenId === activeTokenIdForAddress) || tokensForAddress[0];
  }
);

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
        set(state => ({
          tokensByAddress: {

            ...state.tokensByAddress,
            [addr.toLowerCase() as Address]: tokens
          }
        })),
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
          const updatedTokensByAddress: Record<Address, TokenData[]> = {}
          for (const [addr, tokens] of Object.entries(state.tokensByAddress)) {
            const filtered = tokens.filter(t => t.tokenId !== tokenId)
            if (filtered.length > 0) {
              updatedTokensByAddress[addr as Address] = filtered
            }
          }
          return {
            tokensByAddress: updatedTokensByAddress,
            activeTokenId: state.activeTokenId === tokenId ? undefined : state.activeTokenId,
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


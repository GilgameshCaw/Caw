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
  setHasHydrated: () => void;
  removeActiveToken: () => void;
  bumpCawonce:  (tokenId: number) => void;
  setTokensForAddress: (addr: Address, tokens: TokenData[]) => void;
  removeAddress: (addr: Address) => void;
  allTokens: () => TokenData[]


  setLastAddress: (addr: string) => void;
  setActiveTokenId:   (tokenId?: number|bigint) => void;
  setActiveTokenIdForAddress: (addr: Address, tokenId: number) => void;

  setCawonce:   (tokenId: number, cawonce: number) => void;
  refetchTokenData: (() => void) | null;
  setRefetchTokenData: (fn: () => void) => void;
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
      setActiveTokenIdForAddress: (addr, tokenId) => set(state => ({
        activeTokenIdByAddress: {
          ...state.activeTokenIdByAddress,
          [addr.toLowerCase() as Address]: tokenId
        }
      })),
      setLastAddress: (address) => {
        console.log("SETTING ADDRESS:::::::::::::::", address);
        set({ lastAddress: address.toLowerCase() })
      },
      removeActiveToken: () => set({ activeTokenId: undefined }),

      setCawonce: (tokenId, cawonce) =>
        set(state => ({
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
        hasHydrated:     state.hasHydrated
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


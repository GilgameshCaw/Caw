import { Address } from "viem";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { TokenData } from "~/types";



interface TokenDataStore {
  tokensByAddress: Record<Address, TokenData[]>;
  lastAddress?: string;
  hasHydrated: boolean;
  activeTokenId?: number;
  setHasHydrated: () => void;
  removeActiveToken: () => void;
  bumpCawonce:  (tokenId: number) => void;
  hiddenTokenIds: Record<Address, number[]>;
  setTokensForAddress: (addr: Address, tokens: TokenData[]) => void;
  hideToken: (addr: Address, tokenId: number) => void;
  allTokens: () => TokenData[]


  setLastAddress: (addr: string) => void;
  setActiveTokenId:   (tokenId?: number|bigint) => void;

  setCawonce:   (tokenId: number, cawonce: number) => void;
}

export const useActiveToken = () =>
  useTokenDataStore(state => {
    const tokens = Object.values(state.tokensByAddress).flat()
    return tokens.find(t => t.tokenId === state.activeTokenId) || tokens[0];
  }
);

export const useTokenDataStore = create<TokenDataStore>()(
  persist(
    (set, get) => ({
      hiddenTokenIds: {},
      hasHydrated: false,
      tokensByAddress: {},
      lastAddress: undefined,
      activeTokenId: undefined,
      allTokens: () => {
        const { tokensByAddress } = get()
        return Object.values(tokensByAddress).flat()
      },
      setHasHydrated: () => set({ hasHydrated: true }),
      setTokensForAddress: (addr, tokens) =>
        set(state => ({
          tokensByAddress: {

            ...state.tokensByAddress,
            [addr]: tokens
          }
        })),
      hideToken: (addr, tokenId) =>
        set(state => ({
          hiddenTokenIds: {
            ...state.hiddenTokenIds,
            [addr]: [...(state.hiddenTokenIds[addr]||[]), tokenId]
          }
        })),

      setActiveTokenId: (tokenId) => set({ activeTokenId: Number(tokenId) }),
      setLastAddress: (address) => {console.log("SETTING ADDRESS:::::::::::::::", address);set({ lastAddress: address })},
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
          console.log("LOCAK SET ITEM:", name, str)
          localStorage.setItem(name, str)
        },
        removeItem: (name) => {
          localStorage.removeItem(name)
        }
      },
      partialize: (state) => ({          // only persist the ID
        tokensByAddress: state.tokensByAddress,
        hiddenTokenIds:  state.hiddenTokenIds,
        activeTokenId:   state.activeTokenId,
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


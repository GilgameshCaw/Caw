import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Optimistic post-hide tracking. When a user deletes their own post, the
// on-chain hide action takes 5–60s to land in the indexer. Without this
// store, the post stays visible to the deleter for that whole window.
//
// Persisted because navigation between feed pages (Home → Profile → Home)
// would otherwise re-fetch and the deleted post would briefly reappear.
//
// Entries are by cawonce because that's the stable identifier we have at
// the moment of deletion (the on-chain action targets the cawonce, not the
// DB id). Feed.tsx filters items where item.cawonce is in this set.
//
// 30-day TTL: the indexer's hide is permanent, so once it lands the post
// is filtered server-side and our optimistic entry becomes redundant.
// Keeping entries forever just bloats localStorage; 30 days is far past
// any reasonable indexer lag.

interface HiddenCawEntry {
  cawonce: number
  hiddenAt: number
}

interface HiddenCawsStore {
  hiddenCawonces: Record<number, HiddenCawEntry>
  hideCaw: (cawonce: number) => void
  isHidden: (cawonce: number | undefined | null) => boolean
  clear: () => void
}

const TTL_MS = 30 * 24 * 60 * 60 * 1000

export const useHiddenCawsStore = create<HiddenCawsStore>()(
  persist(
    (set, get) => ({
      hiddenCawonces: {},

      hideCaw: (cawonce) => {
        if (!cawonce) return
        set((state) => ({
          hiddenCawonces: {
            ...state.hiddenCawonces,
            [cawonce]: { cawonce, hiddenAt: Date.now() },
          },
        }))
      },

      isHidden: (cawonce) => {
        if (cawonce == null) return false
        const entry = get().hiddenCawonces[Number(cawonce)]
        if (!entry) return false
        if (Date.now() - entry.hiddenAt > TTL_MS) return false
        return true
      },

      clear: () => set({ hiddenCawonces: {} }),
    }),
    { name: 'caw:hidden-caws' },
  ),
)

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Optimistic pin tracking. When a user pins a post, the on-chain pin
// (or off-chain API write, less commonly) takes a beat to land — the
// OTHER action takes 5–60s to index. Without this store, the pinned
// post snaps back down on refresh until the server reflects the change.
//
// Persisted because the user might refresh, navigate away, or open the
// profile in another tab during that window — all of which should still
// show the pin sitting at the top.
//
// One entry per (current-user) userId — pin is single per user, so the
// last pending action wins. Mirrors the same key shape on the server.
//
// `cawId` semantics:
//   number → "this user pinned this caw, awaiting indexer confirmation"
//   null   → "this user unpinned, awaiting indexer confirmation"
//   absent → no pending action
//
// Reconciliation: when the server-shaped feed reports the user's actual
// pinned caw and it matches our pending state, we clear the entry. If
// the indexer rejects the action (e.g. signature failed), the entry
// will eventually time out via the TTL — at which point the UI snaps
// back to server truth.

interface PendingPinEntry {
  cawId: number | null  // null = pending unpin
  setAt: number
}

interface PendingPinsStore {
  // Keyed by userId. One entry per user.
  pending: Record<number, PendingPinEntry>
  setPending: (userId: number, cawId: number | null) => void
  clearPending: (userId: number) => void
  getPending: (userId: number | undefined | null) => PendingPinEntry | undefined
}

// 5 minutes — way more than typical indexer lag (5–60s) but short enough
// that a pin that genuinely failed (rejected signature, network error)
// doesn't haunt the UI forever.
const TTL_MS = 5 * 60 * 1000

export const usePendingPinsStore = create<PendingPinsStore>()(
  persist(
    (set, get) => ({
      pending: {},

      setPending: (userId, cawId) => {
        if (!userId) return
        set((state) => ({
          pending: {
            ...state.pending,
            [userId]: { cawId, setAt: Date.now() },
          },
        }))
      },

      clearPending: (userId) => {
        if (!userId) return
        set((state) => {
          const { [userId]: _removed, ...rest } = state.pending
          return { pending: rest }
        })
      },

      getPending: (userId) => {
        if (userId == null) return undefined
        const entry = get().pending[Number(userId)]
        if (!entry) return undefined
        if (Date.now() - entry.setAt > TTL_MS) return undefined
        return entry
      },
    }),
    { name: 'caw:pending-pins' },
  ),
)

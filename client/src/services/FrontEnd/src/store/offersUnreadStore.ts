import { create } from 'zustand'

interface OffersUnreadState {
  unreadCount: number
  setUnreadCount: (count: number) => void
  /** Optimistically decrement the badge by `delta` (default 1), clamped
   *  at 0. Use after an action that deactivates a pending offer (accept,
   *  deny/dismiss) so the sidebar badge drops immediately instead of
   *  waiting up to 30s for useBadgeSync's poll. The next poll re-asserts
   *  the authoritative server count, so any over-decrement self-heals. */
  optimisticDecrement: (delta?: number) => void
}

export const useOffersUnreadStore = create<OffersUnreadState>((set) => ({
  unreadCount: 0,
  setUnreadCount: (count) => set({ unreadCount: count }),
  optimisticDecrement: (delta = 1) =>
    set(state => ({ unreadCount: Math.max(0, state.unreadCount - delta) })),
}))

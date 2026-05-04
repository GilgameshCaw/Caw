import { create } from 'zustand'

interface SalesUnreadState {
  unreadCount: number
  setUnreadCount: (count: number) => void
}

export const useSalesUnreadStore = create<SalesUnreadState>((set) => ({
  unreadCount: 0,
  setUnreadCount: (count) => set({ unreadCount: count }),
}))

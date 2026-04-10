import { create } from 'zustand'

interface OffersUnreadState {
  unreadCount: number
  setUnreadCount: (count: number) => void
}

export const useOffersUnreadStore = create<OffersUnreadState>((set) => ({
  unreadCount: 0,
  setUnreadCount: (count) => set({ unreadCount: count }),
}))

import { create } from 'zustand'

interface DmUnreadState {
  totalUnread: number
  setTotalUnread: (count: number) => void
}

export const useDmUnreadStore = create<DmUnreadState>((set) => ({
  totalUnread: 0,
  setTotalUnread: (count) => set({ totalUnread: count }),
}))

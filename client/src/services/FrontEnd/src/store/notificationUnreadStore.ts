import { create } from 'zustand'

interface NotificationUnreadState {
  unreadCount: number
  setUnreadCount: (count: number) => void
}

export const useNotificationUnreadStore = create<NotificationUnreadState>((set) => ({
  unreadCount: 0,
  setUnreadCount: (count) => set({ unreadCount: count }),
}))

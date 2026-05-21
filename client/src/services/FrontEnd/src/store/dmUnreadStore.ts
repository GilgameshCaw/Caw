import { create } from 'zustand'

interface DmUnreadState {
  /** Sum of unread MESSAGE counts across all conversations. Kept for any
   *  surface that wants a true message-volume signal (favicon, OS badge,
   *  titlebar). The drawer's Messages badge prefers `unreadConversations`
   *  per user request — they want to see "how many people are waiting on
   *  me", not "how many messages are queued". */
  totalUnread: number
  /** Number of CONVERSATIONS that have ≥1 unread message. This is what
   *  the sidebar / drawer badge renders. */
  unreadConversations: number
  setTotalUnread: (count: number) => void
  /** Derive both counters from a conversation list in one call so callers
   *  don't have to compute them twice. Filters out muted conversation
   *  ids if `mutedIds` is provided (matches how every caller already
   *  filters before passing the list in). */
  setUnreadFromConversations: (
    conversations: Array<{ id: string; unreadCount?: number | null }>,
    mutedIds?: string[],
  ) => void
}

export const useDmUnreadStore = create<DmUnreadState>((set) => ({
  totalUnread: 0,
  unreadConversations: 0,
  setTotalUnread: (count) => set({ totalUnread: count }),
  setUnreadFromConversations: (conversations, mutedIds = []) => {
    const muted = mutedIds.length > 0 ? new Set(mutedIds) : null
    let totalUnread = 0
    let unreadConversations = 0
    for (const c of conversations) {
      if (muted && muted.has(c.id)) continue
      const n = c.unreadCount ?? 0
      if (n > 0) {
        totalUnread += n
        unreadConversations += 1
      }
    }
    set({ totalUnread, unreadConversations })
  },
}))

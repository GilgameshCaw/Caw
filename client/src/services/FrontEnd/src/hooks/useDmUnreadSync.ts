import { useEffect } from 'react'
import { useActiveToken } from '~/store/tokenDataStore'
import { useAuthStore } from '~/store/authStore'
import { useDmUnreadStore } from '~/store/dmUnreadStore'
import { useDmMuteStore } from '~/store/dmMuteStore'
import { apiFetch } from '~/api/client'

/**
 * Fetches DM unread count on app load and periodically.
 * Runs globally (in App.tsx) so the sidebar badge works on any page.
 */
export function useDmUnreadSync() {
  const activeToken = useActiveToken()
  const tokenId = activeToken?.tokenId
  const isAuthorized = useAuthStore(s => tokenId ? s.isTokenAuthorized(tokenId) : false)

  useEffect(() => {
    if (!tokenId || !isAuthorized) return

    let cancelled = false

    const fetchUnread = async () => {
      try {
        const data = await apiFetch<{ conversations: Array<{ id: string; unreadCount?: number }> }>(
          `/api/dm/conversations?userId=${tokenId}`
        )
        if (cancelled) return
        const mutedIds = useDmMuteStore.getState().mutedConversations
        const total = (data.conversations || [])
          .filter(c => !mutedIds.includes(c.id))
          .reduce((sum, c) => sum + (c.unreadCount || 0), 0)
        useDmUnreadStore.getState().setTotalUnread(total)
      } catch {
        // Silently fail — user may not have DMs enabled
      }
    }

    fetchUnread()

    // Poll every 60 seconds
    const interval = setInterval(fetchUnread, 60_000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [tokenId, isAuthorized])
}

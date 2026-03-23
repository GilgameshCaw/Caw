import { useEffect } from 'react'
import { useActiveToken } from '~/store/tokenDataStore'
import { useAuthStore } from '~/store/authStore'
import { useNotificationUnreadStore } from '~/store/notificationUnreadStore'
import { apiFetch } from '~/api/client'

/**
 * Fetches notification unread count on app load and periodically.
 * Runs globally (in App.tsx) so the sidebar badge works on any page.
 */
export function useNotificationUnreadSync() {
  const activeToken = useActiveToken()
  const tokenId = activeToken?.tokenId
  const isAuthorized = useAuthStore(s => tokenId ? s.isTokenAuthorized(tokenId) : false)

  useEffect(() => {
    if (!tokenId || !isAuthorized) return

    let cancelled = false

    const fetchUnread = async () => {
      try {
        const data = await apiFetch<{ unreadCount: number }>(
          `/api/notifications/unread-count?userId=${tokenId}`
        )
        if (!cancelled) {
          useNotificationUnreadStore.getState().setUnreadCount(data.unreadCount)
        }
      } catch {
        // Silently fail
      }
    }

    fetchUnread()

    // Poll every 30 seconds
    const interval = setInterval(fetchUnread, 30_000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [tokenId, isAuthorized])
}

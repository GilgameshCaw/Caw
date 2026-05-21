import { useEffect, useRef } from 'react'
import { useActiveToken } from '~/store/tokenDataStore'
import { useAuthStore } from '~/store/authStore'
import { useDmUnreadStore } from '~/store/dmUnreadStore'
import { useDmMuteStore } from '~/store/dmMuteStore'
import { useNotificationUnreadStore } from '~/store/notificationUnreadStore'
import { useOffersUnreadStore } from '~/store/offersUnreadStore'
import { useSalesUnreadStore } from '~/store/salesUnreadStore'
import { apiFetch } from '~/api/client'

interface BadgesResponse {
  notifications: number
  offers: number
  sales: number
  dmConversations: { id: string; unreadCount: number }[]
}

/**
 * Combined poll for sidebar badge counts (notifications, marketplace offers, DMs).
 * Pauses polling when the tab is not visible to reduce server load at scale.
 * Fetches immediately when the tab regains focus.
 */
export function useBadgeSync() {
  const activeToken = useActiveToken()
  const tokenId = activeToken?.tokenId
  const isAuthorized = useAuthStore(s => tokenId ? s.isTokenAuthorized(tokenId) : false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    if (!tokenId || !isAuthorized) return

    cancelledRef.current = false

    const fetchBadges = async () => {
      if (cancelledRef.current) return
      try {
        const data = await apiFetch<BadgesResponse>(`/api/users/badges?userId=${tokenId}`)
        if (cancelledRef.current) return
        useNotificationUnreadStore.getState().setUnreadCount(data.notifications)
        useOffersUnreadStore.getState().setUnreadCount(data.offers)
        useSalesUnreadStore.getState().setUnreadCount(data.sales ?? 0)
        // Compute both totalUnread (sum of messages) AND
        // unreadConversations (count of conversations with ≥1 unread) in
        // one pass — the drawer badge renders the latter; the former is
        // kept for any volume-aware surface.
        const mutedIds = useDmMuteStore.getState().mutedConversations
        useDmUnreadStore.getState().setUnreadFromConversations(
          data.dmConversations || [],
          mutedIds,
        )
      } catch {
        // Silently fail — badges are non-critical
      }
    }

    const startPolling = () => {
      if (intervalRef.current) return
      intervalRef.current = setInterval(fetchBadges, 30_000)
    }

    const stopPolling = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }

    const onVisibilityChange = () => {
      if (document.hidden) {
        stopPolling()
      } else {
        // Tab regained focus — fetch immediately then resume polling
        fetchBadges()
        startPolling()
      }
    }

    // Initial fetch + start polling
    fetchBadges()
    startPolling()
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelledRef.current = true
      stopPolling()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [tokenId, isAuthorized])
}

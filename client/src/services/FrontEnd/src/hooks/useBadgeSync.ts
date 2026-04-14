import { useEffect } from 'react'
import { useActiveToken } from '~/store/tokenDataStore'
import { useAuthStore } from '~/store/authStore'
import { useDmUnreadStore } from '~/store/dmUnreadStore'
import { useDmMuteStore } from '~/store/dmMuteStore'
import { useNotificationUnreadStore } from '~/store/notificationUnreadStore'
import { useOffersUnreadStore } from '~/store/offersUnreadStore'
import { apiFetch } from '~/api/client'

interface BadgesResponse {
  notifications: number
  offers: number
  dmConversations: { id: string; unreadCount: number }[]
}

/**
 * Combined poll for sidebar badge counts (notifications, marketplace offers, DMs).
 * Replaces three separate sync hooks with a single 30s round-trip.
 */
export function useBadgeSync() {
  const activeToken = useActiveToken()
  const tokenId = activeToken?.tokenId
  const isAuthorized = useAuthStore(s => tokenId ? s.isTokenAuthorized(tokenId) : false)

  useEffect(() => {
    if (!tokenId || !isAuthorized) return

    let cancelled = false

    const fetchBadges = async () => {
      try {
        const data = await apiFetch<BadgesResponse>(`/api/users/badges?userId=${tokenId}`)
        if (cancelled) return
        useNotificationUnreadStore.getState().setUnreadCount(data.notifications)
        useOffersUnreadStore.getState().setUnreadCount(data.offers)
        const mutedIds = useDmMuteStore.getState().mutedConversations
        const dmTotal = (data.dmConversations || [])
          .filter(c => !mutedIds.includes(c.id))
          .reduce((sum, c) => sum + (c.unreadCount || 0), 0)
        useDmUnreadStore.getState().setTotalUnread(dmTotal)
      } catch {
        // Silently fail — badges are non-critical
      }
    }

    fetchBadges()
    const interval = setInterval(fetchBadges, 30_000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [tokenId, isAuthorized])
}

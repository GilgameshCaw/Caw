import { useEffect } from 'react'
import { useActiveToken } from '~/store/tokenDataStore'
import { useAuthStore } from '~/store/authStore'
import { useOffersUnreadStore } from '~/store/offersUnreadStore'
import { apiFetch } from '~/api/client'

/**
 * Fetches unseen received offers count on app load and periodically.
 * Uses authenticated endpoint so the count is server-tracked.
 * Runs globally (in App.tsx) so the sidebar badge works on any page.
 */
export function useOffersUnreadSync() {
  const activeToken = useActiveToken()
  const tokenId = activeToken?.tokenId
  const isAuthorized = useAuthStore(s => tokenId ? s.isTokenAuthorized(tokenId) : false)

  useEffect(() => {
    if (!tokenId || !isAuthorized) return

    let cancelled = false

    const fetchCount = async () => {
      try {
        const data = await apiFetch<{ count: number }>(
          `/api/marketplace/offers/unseen-count?userId=${tokenId}`
        )
        if (!cancelled) {
          useOffersUnreadStore.getState().setUnreadCount(data.count)
        }
      } catch {
        // Silently fail
      }
    }

    fetchCount()

    // Poll every 30 seconds
    const interval = setInterval(fetchCount, 30_000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [tokenId, isAuthorized])
}

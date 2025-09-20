import { useEffect, useRef } from 'react'
import { useActiveToken } from '~/store/tokenDataStore'
import { apiFetch } from '~/api/client'

interface ViewTrackingOptions {
  enabled?: boolean
  debounceMs?: number
}

/**
 * Hook to track views for caws
 * Automatically tracks views when caws become visible in the viewport
 */
export function useViewTracking(cawIds: number[], options: ViewTrackingOptions = {}) {
  const { enabled = true, debounceMs = 2000 } = options
  const activeToken = useActiveToken()
  const trackedRef = useRef<Set<number>>(new Set())
  const timeoutRef = useRef<NodeJS.Timeout>()

  useEffect(() => {
    if (!enabled || cawIds.length === 0) return

    // Filter out already tracked caws in this session
    const untracked = cawIds.filter(id => !trackedRef.current.has(id))

    if (untracked.length === 0) return

    // Clear existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }

    // Debounce the tracking call to batch multiple caws
    timeoutRef.current = setTimeout(async () => {
      try {
        // Mark as tracked immediately to prevent duplicate calls
        untracked.forEach(id => trackedRef.current.add(id))

        const headers: Record<string, string> = {}
        if (activeToken?.tokenId) {
          headers['x-user-id'] = activeToken.tokenId.toString()
        }

        await apiFetch('/api/views/track-bulk', {
          method: 'POST',
          headers,
          body: JSON.stringify({ cawIds: untracked })
        })
      } catch (error) {
        console.error('Failed to track views:', error)
        // Remove from tracked on error to allow retry
        untracked.forEach(id => trackedRef.current.delete(id))
      }
    }, debounceMs)

    // Cleanup timeout on unmount
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [cawIds, enabled, activeToken?.tokenId, debounceMs])
}

/**
 * Hook to track a single caw view
 */
export function useViewTrackingSingle(cawId: number | undefined, options: ViewTrackingOptions = {}) {
  useViewTracking(cawId ? [cawId] : [], options)
}
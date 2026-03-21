import { useState, useEffect } from 'react'
import { API_HOST } from '~/api/client'

/**
 * Check whether a user has registered a DM identity (public key).
 * Uses the public /api/dm/identity/:userId endpoint — no auth needed.
 */
export function useDmIdentity(userId?: number) {
  const [hasIdentity, setHasIdentity] = useState<boolean | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!userId) {
      setHasIdentity(null)
      return
    }

    let cancelled = false
    setIsLoading(true)

    fetch(`${API_HOST}/api/dm/identity/${userId}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) setHasIdentity(!!data.hasIdentity)
      })
      .catch(() => {
        if (!cancelled) setHasIdentity(null)
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => { cancelled = true }
  }, [userId])

  return { hasIdentity, isLoading }
}

import { useQuery } from '@tanstack/react-query'
import { API_HOST } from '~/api/client'

/**
 * Check whether a user has registered a DM identity (public key).
 * Uses the public /api/dm/identity/:userId endpoint — no auth needed.
 */
export function useDmIdentity(userId?: number) {
  const { data: hasIdentity = null, isLoading } = useQuery<boolean | null>({
    queryKey: ['dmIdentity', userId],
    queryFn: async () => {
      const res = await fetch(`${API_HOST}/api/dm/identity/${userId}`)
      const data = await res.json()
      return !!data.hasIdentity
    },
    enabled: !!userId,
    staleTime: 60 * 1000, // 1 minute
  })

  return { hasIdentity, isLoading }
}

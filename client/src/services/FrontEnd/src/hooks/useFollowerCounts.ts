import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { apiFetch } from '~/api/client'

interface UserByTokenSlim {
  tokenId: number
  followerCount: number
  [key: string]: any
}

/**
 * Fetches follower counts for a list of tokenIds in parallel via the
 * existing /api/users/by-token/:tokenId endpoint. React Query coalesces
 * shared keys across components, so this is cheap to call from multiple
 * places (ProfileChooser, AccountSettings, etc.).
 *
 * Returns a stable lookup map; values are undefined while loading. Sorting
 * callers should fall back to 0 for missing entries so the order remains
 * deterministic during the brief loading window.
 */
export function useFollowerCounts(tokenIds: number[]): Record<number, number | undefined> {
  const results = useQueries({
    queries: tokenIds.map(id => ({
      queryKey: ['userByToken', id],
      queryFn: () => apiFetch<UserByTokenSlim>(`/api/users/by-token/${id}`),
      enabled: !!id,
      staleTime: 60_000,
    })),
  })

  return useMemo(() => {
    const map: Record<number, number | undefined> = {}
    tokenIds.forEach((id, i) => {
      const data = results[i]?.data as UserByTokenSlim | undefined
      map[id] = data?.followerCount
    })
    return map
  }, [tokenIds.join(','), results.map(r => r.data?.followerCount).join(',')])
}

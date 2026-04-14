import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '~/api/client'

interface UserData {
  username: string
  displayName?: string
  avatarUrl?: string
  followingCount: number
  followerCount: number
  tokenId: number
  [key: string]: any
}

/**
 * Fetches user data by username via React Query.
 * Multiple components calling this with the same username will share a single request.
 */
export function useUserByUsername(username?: string) {
  return useQuery<UserData>({
    queryKey: ['user', username],
    queryFn: () => apiFetch<UserData>(`/api/users/${username}`),
    enabled: !!username,
  })
}

interface UserByTokenData {
  username: string
  stakedAmount?: string
  pendingDepositAmount?: string
  [key: string]: any
}

/**
 * Fetches user data by token ID via React Query.
 * Multiple components calling this with the same tokenId will share a single request.
 *
 * Pass `refetchInterval` (in ms) for polling consumers — if multiple
 * consumers poll the same tokenId, React Query coalesces them so only
 * one network request fires per interval.
 */
export function useUserByToken(tokenId?: number, refetchInterval?: number) {
  return useQuery<UserByTokenData>({
    queryKey: ['userByToken', tokenId],
    queryFn: () => apiFetch<UserByTokenData>(`/api/users/by-token/${tokenId}`),
    enabled: !!tokenId,
    refetchInterval,
  })
}

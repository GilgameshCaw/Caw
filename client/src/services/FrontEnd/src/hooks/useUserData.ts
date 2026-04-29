import { useQuery } from '@tanstack/react-query'
import { apiFetch, IndexingError } from '~/api/client'

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
 * React Query retry config: when the API replies 202 ("user not yet indexed")
 * the fetcher throws IndexingError. We retry up to 5 times with backoff
 * driven by the server's retryAfterSeconds hint, capped at 10s. Other errors
 * (network, 4xx, 5xx) bubble straight through — React Query's defaults treat
 * them as terminal failures unless the consumer overrides.
 */
const INDEXING_RETRY_MAX = 5
const INDEXING_RETRY_CAP_MS = 10_000
const indexingRetry = (failureCount: number, error: Error) => {
  if (!(error instanceof IndexingError)) return false
  return failureCount < INDEXING_RETRY_MAX
}
const indexingRetryDelay = (failureCount: number, error: Error) => {
  if (!(error instanceof IndexingError)) return 0
  const indexingErr = error as IndexingError
  const hint = indexingErr.retryAfterSeconds * 1000
  return Math.min(hint * Math.pow(2, failureCount), INDEXING_RETRY_CAP_MS)
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
    retry: indexingRetry,
    retryDelay: indexingRetryDelay,
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
    retry: indexingRetry,
    retryDelay: indexingRetryDelay,
  })
}

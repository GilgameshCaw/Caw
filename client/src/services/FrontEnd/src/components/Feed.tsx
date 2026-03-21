// src/services/FrontEnd/src/components/Feed.tsx
import React, { useEffect, useState, useCallback, forwardRef, useImperativeHandle, useMemo, useRef } from 'react'
import { useTokenDataStore } from '~/store/tokenDataStore'
import FeedItem from './FeedItem'
import { apiFetch } from '../api/client'
import { User, CawItem } from '~/types'
import { useTheme } from '~/hooks/useTheme'
import { usePendingPostsStore } from '~/store/pendingPostsStore'
import { useViewTracking } from '~/hooks/useViewTracking'
import { useMutePreferences, shouldFilterPost } from '~/hooks/useMutePreferences'
import { setFeedRefreshCallback } from '~/hooks/useTxQueueMonitor'
import { useBlockedUsersStore } from '~/store/blockedUsersStore'
import SuggestedUsers from './SuggestedUsers'

type Props = {
  filter: 'For you' | 'Following' | 'profile' | 'profile-likes' | 'profile-replies' | 'profile-media' | string
  username?: string
  apiEndpoint?: string
}

// whatever shape your backend now returns
type FeedResponse = {
  items: CawItem[]
  nextCursor?: number
}

export interface FeedRef {
  refresh: () => void
}

const Feed = forwardRef<FeedRef, Props>(({ filter, username, apiEndpoint }, ref) => {
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const activeToken = useTokenDataStore(s => {
    const tokens = Object.values(s.tokensByAddress).flat()
    return tokens.find(t => t.tokenId === s.activeTokenId) || tokens[0]
  })
  const pendingPosts = usePendingPostsStore(s => s.pendingPosts)
  const { isDark } = useTheme()
  const { preferences } = useMutePreferences()
  const blockedUsers = useBlockedUsersStore(s => s.blockedUsers)
  const [items,      setItems]      = useState<CawItem[]>([])
  const [nextCursor, setNextCursor] = useState<number|undefined>(undefined)
  const [hasMore,    setHasMore]    = useState(true)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState<string>()
  const [followingCount, setFollowingCount] = useState<number | null>(null)

  // Filter items based on mute preferences and blocked users
  const filteredItems = useMemo(() => {
    const blockedUserIds = blockedUsers.map(u => u.tokenId)
    // Build a set of pending post signatures (content + userId) to dedupe DB pending posts
    const pendingPostSignatures = new Set(
      pendingPosts.map(p => `${p.user?.tokenId}:${p.content?.trim()}`)
    )

    return items.filter(item => {
      // Filter out muted content
      if (shouldFilterPost(item, preferences)) return false
      // Filter out blocked users
      if (blockedUserIds.includes(item.user.tokenId)) return false
      // Filter out DB PENDING posts that match local pending posts (same user + content)
      if (item.status === 'PENDING') {
        const signature = `${item.user.tokenId}:${item.content?.trim()}`
        if (pendingPostSignatures.has(signature)) return false
      }
      return true
    })
  }, [items, preferences, blockedUsers, pendingPosts])

  // Expose refresh method via ref
  useImperativeHandle(ref, () => ({
    refresh: () => {
      setItems([])
      setNextCursor(undefined)
      setHasMore(true)
      loadPage(true)
    }
  }), [])

  // Track views for visible caws (use filtered items)
  const visibleCawIds = filteredItems.map(item => item.id).filter(id => id != null)
  useViewTracking(visibleCawIds)

  // Ref for loadPage to use in callbacks
  const loadPageRef = useRef<((force?: boolean) => Promise<void>) | null>(null)

  // load one "page" of results
  const loadPage = useCallback(async (force = false) => {
    if (loading || (!hasMore && !force)) return
    setLoading(true)
    setError(undefined)

    const cursorToUse = force ? undefined : nextCursor

    // Use custom API endpoint if provided (for hashtag feeds)
    if (apiEndpoint) {
      const params = new URLSearchParams()
      if (cursorToUse != null) {
        // Use 'offset' for search endpoints, 'cursor' for others
        const paramName = apiEndpoint.includes('/search') ? 'offset' : 'cursor'
        params.set(paramName, String(cursorToUse))
      }

      try {
        // Check if apiEndpoint already has query params
        const separator = apiEndpoint.includes('?') ? '&' : '?'
        const url = params.toString()
          ? `${apiEndpoint}${separator}${params.toString()}`
          : apiEndpoint

        const response = await apiFetch<FeedResponse>(url)
        const newItems = response.items || []
        const newCursor = response.nextCursor

        setItems(current => {
          return force ? newItems : [...current, ...newItems]
        })
        setNextCursor(newCursor)
        setHasMore(newCursor != null)
      } catch (err: any) {
        console.error('Custom feed load error', err)
        setError('Failed to load feed')
      } finally {
        setLoading(false)
      }
      return
    }

    // Default caws API logic
    const params = new URLSearchParams()
    if (filter === 'Following') {
      params.set('filter', 'following')
    }
    // new profile‐only:
    if (filter === 'profile' && username) {
      // Fetch only this user's posts
      params.set('user', username)
    }

    // new profile‐likes:
    if (filter === 'profile-likes' && username) {
      // Fetch only this user's liked posts
      params.set('user', username)
      params.set('filter', 'liked')
    }

    // profile-media:
    if (filter === 'profile-media' && username) {
      // Fetch posts with images/videos by this user (including recaws)
      params.set('user', username)
      params.set('filter', 'media')
    }

    // profile-replies:
    if (filter === 'profile-replies' && username) {
      // Fetch replies by this user
      params.set('user', username)
      params.set('filter', 'replies')
    }

    if (nextCursor != null) {
      params.set('cursor', String(cursorToUse))
    }

    try {
      const { items: newItems, nextCursor: newCursor } =
        await apiFetch<FeedResponse>(`/api/caws?${params.toString()}`)

      setItems(current => {
        const seen = new Set<string>()
        return [...current, ...newItems]
          .filter(item => {
            if (seen.has(item.id)) return false
            seen.add(item.id)
            return true
          })
      })

      if (newCursor != null) {
        setNextCursor(newCursor)
      } else {
        setHasMore(false)
      }
    } catch (e) {
      console.error(e)
      setError('Could not load feed')
    } finally {
      setLoading(false)
    }
  }, [filter, nextCursor, hasMore, loading, apiEndpoint, username])

  // Keep loadPage ref updated
  useEffect(() => {
    loadPageRef.current = loadPage
  }, [loadPage])

  // Register feed refresh callback for txQueue monitor (only for main feeds)
  useEffect(() => {
    if (filter === 'For you' || filter === 'Following') {
      const refreshCallback = () => {
        setItems([])
        setNextCursor(undefined)
        setHasMore(true)
        setTimeout(() => {
          if (loadPageRef.current) {
            loadPageRef.current(true)
          }
        }, 50)
      }
      setFeedRefreshCallback(refreshCallback)

      return () => {
        setFeedRefreshCallback(null)
      }
    }
  }, [filter])

  // when filter or username changes, reset everything & load first page
  useEffect(() => {
    setItems([])
    setNextCursor(undefined)
    setHasMore(true)
    loadPage(true)
  }, [filter, activeTokenId, apiEndpoint, username])

  // Fetch following count for current user when on Following tab
  useEffect(() => {
    if (filter !== 'Following' || !activeToken?.username) {
      setFollowingCount(null)
      return
    }

    const fetchFollowingCount = async () => {
      try {
        const response = await apiFetch<{ followingCount: number }>(
          `/api/users/${activeToken.username}`
        )
        setFollowingCount(response.followingCount)
      } catch (err) {
        setFollowingCount(null)
      }
    }

    fetchFollowingCount()
  }, [filter, activeToken?.username])

  // infinite‐scroll: when near bottom, load more
  useEffect(() => {
    function onScroll() {
      // 1) never load while the first page is still coming in
      // 2) never load again if there _isn't_ a nextCursor
      if (loading || !hasMore || nextCursor == null) return

      const nearBottom =
        window.innerHeight + window.scrollY
    >= document.documentElement.offsetHeight - 200
      if (nearBottom) {
        loadPage()
      }
    }
    window.addEventListener('scroll', onScroll)
    return () => window.removeEventListener('scroll', onScroll)
  }, [loadPage, loading, hasMore, nextCursor])

  // Poll for pending likes - refetch specific caws that have pending likes
  useEffect(() => {
    const pendingLikeCaws = items.filter(item => item.likePending)

    if (pendingLikeCaws.length === 0) return

    const interval = setInterval(async () => {
      // Refetch each caw with a pending like
      for (const caw of pendingLikeCaws) {
        try {
          const updated = await apiFetch<{ caw: CawItem }>(`/api/caws/${caw.id}`)

          // Update the specific item in the list
          setItems(current =>
            current.map(item =>
              item.id === caw.id ? updated.caw : item
            )
          )
        } catch (err) {
          // Ignore errors
        }
      }
    }, 3000) // Poll every 3 seconds

    return () => clearInterval(interval)
  }, [items])

  // Poll for pending recaws - refetch specific caws that have pending recaws
  useEffect(() => {
    const pendingRecawCaws = items.filter(item => item.recawPending)

    if (pendingRecawCaws.length === 0) return

    const interval = setInterval(async () => {
      // Refetch each caw with a pending recaw
      for (const caw of pendingRecawCaws) {
        try {
          const updated = await apiFetch<{ caw: CawItem }>(`/api/caws/${caw.id}`)

          // Update the specific item in the list
          // Keep recawPending true until hasRecawed is confirmed (to handle race condition)
          setItems(current =>
            current.map(item => {
              if (item.id === caw.id) {
                const isConfirmed = updated.caw.hasRecawed === true
                // If not yet confirmed, keep recawPending true to continue polling
                return {
                  ...updated.caw,
                  recawPending: isConfirmed ? false : true
                }
              }
              return item
            })
          )
        } catch (err) {
          // Ignore errors
        }
      }
    }, 3000) // Poll every 3 seconds

    return () => clearInterval(interval)
  }, [items])

  // Poll for pending replies - refetch specific caws that have pending replies
  useEffect(() => {
    const pendingReplyCaws = items.filter(item => item.replyPending)

    if (pendingReplyCaws.length === 0) return

    const interval = setInterval(async () => {
      // Refetch each caw with a pending reply
      for (const caw of pendingReplyCaws) {
        try {
          const updated = await apiFetch<{ caw: CawItem }>(`/api/caws/${caw.id}`)

          // Update the specific item in the list
          setItems(current =>
            current.map(item => {
              if (item.id === caw.id) {
                const isConfirmed = updated.caw.hasReplied === true
                // If not yet confirmed, keep replyPending true to continue polling
                return {
                  ...updated.caw,
                  replyPending: isConfirmed ? false : true
                }
              }
              return item
            })
          )
        } catch (err) {
          // Ignore errors
        }
      }
    }, 3000) // Poll every 3 seconds

    return () => clearInterval(interval)
  }, [items])

  // Poll for pending tips - refetch specific caws that have pending tips
  useEffect(() => {
    const pendingTipCaws = items.filter(item => item.tipPending)

    if (pendingTipCaws.length === 0) return

    const interval = setInterval(async () => {
      for (const caw of pendingTipCaws) {
        try {
          const updated = await apiFetch<{ caw: CawItem }>(`/api/caws/${caw.id}`)

          setItems(current =>
            current.map(item => {
              if (item.id === caw.id) {
                return {
                  ...updated.caw,
                  tipPending: updated.caw.tipPending ?? false
                }
              }
              return item
            })
          )
        } catch (err) {
          // Ignore errors
        }
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [items])

  // Helper to refresh following count after a follow action
  // Don't reload the feed immediately — the follow is still processing on-chain.
  // Just update the following count; the feed will refresh naturally.
  const handleFollowChange = useCallback(() => {
    if (activeToken?.username) {
      apiFetch<{ followingCount: number }>(`/api/users/${activeToken.username}`)
        .then(response => setFollowingCount(response.followingCount))
        .catch(err => console.error('Failed to refetch following count:', err))
    }
  }, [activeToken?.username])

  // render
  if (error)   return <div className="text-red-400">Error loading feed: {error}</div>
  if (items.length === 0 && loading) return (
    <div className="space-y-4">
      {[...Array(3)].map((_, i) => (
        <div key={i} className="animate-pulse bg-gray-800 rounded-lg h-32"></div>
      ))}
    </div>
  )
  // Always show suggested users on Following tab
  const showSuggestedUsers = filter === 'Following'

  if (items.length === 0) {
    // Show suggested users when Following feed is empty
    if (filter === 'Following') {
      return (
        <div className="py-4">
          <SuggestedUsers onFollowChange={handleFollowChange} />
        </div>
      )
    }
    return <div className="text-gray-400 text-center py-8">No posts yet.</div>
  }
  if (filteredItems.length === 0) return <div className="text-gray-400 text-center py-8">No posts to show (some may be hidden by your settings).</div>

  return (
    <div>
      {/* Show suggested users at top when following < 10 people */}
      {showSuggestedUsers && (
        <div className={`border-b ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
          <SuggestedUsers onFollowChange={handleFollowChange} />
        </div>
      )}

      {/* Show pending posts at the top (on main feeds, not profiles) */}
      {(filter === 'For you' || filter === 'Following') && pendingPosts.map(post => (
        <FeedItem key={post.tempId} item={post as CawItem} />
      ))}

      {/* Posts with consistent styling across all pages */}
      {filteredItems.map(caw => (
        <FeedItem
          key={caw.id}
          item={caw}
          onLikeStateChange={(cawId, likePending) => {
            console.log('[Feed] Like state changed for caw', cawId, 'pending:', likePending)
            setItems(current =>
              current.map(item =>
                item.id === cawId ? { ...item, likePending } : item
              )
            )
          }}
          onRecawStateChange={(cawId, recawPending) => {
            console.log('[Feed] Recaw state changed for caw', cawId, 'pending:', recawPending, 'type:', typeof cawId)
            setItems(current => {
              const updated = current.map(item => {
                const match = item.id === cawId
                if (match) {
                  console.log('[Feed] Found matching item:', item.id, '- setting recawPending to', recawPending)
                }
                return match ? { ...item, recawPending } : item
              })
              console.log('[Feed] Items with recawPending after update:', updated.filter(i => i.recawPending).map(i => i.id))
              return updated
            })
          }}
          onReplyStateChange={(cawId, replyPending) => {
            console.log('[Feed] Reply state changed for caw', cawId, 'pending:', replyPending)
            setItems(current =>
              current.map(item =>
                item.id === cawId ? { ...item, replyPending } : item
              )
            )
          }}
          onTipStateChange={(cawId, tipPending) => {
            setItems(current =>
              current.map(item =>
                item.id === cawId ? { ...item, tipPending } : item
              )
            )
          }}
        />
      ))}

      {loading && <div className="py-4 text-center text-gray-400">Loading more…</div>}
      {!hasMore && <div className="py-4 text-center text-gray-500">You've reached the end.</div>}
    </div>
  )
})

Feed.displayName = 'Feed'

export default Feed


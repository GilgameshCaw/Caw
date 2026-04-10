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
import { setFeedRefreshCallback, setFeedItemUpdateCallback, setFeedRefreshVisibleCallback } from '~/hooks/useTxQueueMonitor'
import { useBlockedUsersStore } from '~/store/blockedUsersStore'
import SuggestedUsers from './SuggestedUsers'
import { useHostVerification } from '~/hooks/useHostVerification'
import { useUserByUsername } from '~/hooks/useUserData'
import { useQueryClient } from '@tanstack/react-query'

type Props = {
  filter: 'For you' | 'Following' | 'profile' | 'profile-likes' | 'profile-replies' | 'profile-media' | string
  username?: string
  apiEndpoint?: string
  title?: React.ReactNode
}

// whatever shape your backend now returns
type FeedResponse = {
  items: CawItem[]
  nextCursor?: number
}

export interface FeedRef {
  refresh: () => void
}

const Feed = forwardRef<FeedRef, Props>(({ filter, username, apiEndpoint, title }, ref) => {
  const qc = useQueryClient()
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

  // Ref to track current items without causing effect re-runs
  const itemsRef = useRef<CawItem[]>(items)
  useEffect(() => { itemsRef.current = items }, [items])

  // Filter items based on mute preferences and blocked users
  const filteredItems = useMemo(() => {
    const blockedUserIds = blockedUsers.map(u => u.tokenId)
    // Build a set of pending post signatures (content + userId) to dedupe DB pending posts
    const pendingPostSignatures = new Set(
      pendingPosts.map(p => `${p.user?.tokenId}:${p.content?.trim()}`)
    )

    const filtered = items.filter(item => {
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

    // Group thread replies with their parent post and sort by cawonce ascending.
    // The feed comes in desc order, so a thread's replies appear before the parent.
    // We collect runs of replies to the same parent, find the parent post if it's
    // nearby in the array, and reorder so: parent → reply 1 → reply 2 → ...

    // First pass: find all reply runs and their parent IDs
    const consumed = new Set<number>() // indices consumed into a thread group
    const result: CawItem[] = []
    let i = 0
    while (i < filtered.length) {
      if (consumed.has(i)) { i++; continue }
      const item = filtered[i]
      if (item.parent?.id) {
        const parentId = item.parent.id
        const userId = item.user.tokenId
        // Collect consecutive replies to the same parent by the same user
        let j = i + 1
        while (j < filtered.length && filtered[j].parent?.id === parentId && filtered[j].user.tokenId === userId) {
          j++
        }
        if (j - i > 1) {
          // Look for the parent post in the remaining items (it's usually right after the run)
          let parentIdx = -1
          for (let k = j; k < filtered.length && k < j + 5; k++) {
            if (filtered[k].id === parentId && !consumed.has(k)) {
              parentIdx = k
              break
            }
          }
          // Sort replies by cawonce ascending
          const run = filtered.slice(i, j).sort((a, b) => (a.cawonce ?? 0) - (b.cawonce ?? 0))
          // If parent found, place it before the replies
          if (parentIdx >= 0) {
            consumed.add(parentIdx)
            result.push(filtered[parentIdx])
          }
          result.push(...run)
          i = j
          continue
        }
      }
      result.push(item)
      i++
    }
    return result
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

  // Spot-check posts against on-chain data to detect dishonest API hosts
  // Memoize to avoid creating new arrays on every render
  const verificationItems = useMemo(() => filteredItems.map(item => ({
    user: { tokenId: item.user?.tokenId || 0 },
    cawonce: item.cawonce || 0,
    content: item.content,
    status: item.status,
  })), [filteredItems])
  useHostVerification(verificationItems)

  // Track views for visible caws (memoize to avoid re-triggering on every render)
  const visibleCawIds = useMemo(() => filteredItems.map(item => item.id).filter(id => id != null), [filteredItems])
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
        // Don't clear items — that causes a flash/scroll-jump.
        // Just re-fetch the first page; loadPage(true) replaces items atomically.
        setNextCursor(undefined)
        setHasMore(true)
        if (loadPageRef.current) {
          loadPageRef.current(true)
        }
      }
      setFeedRefreshCallback(refreshCallback)
      setFeedItemUpdateCallback((cawId, updates) => {
        setItems(current => current.map(item =>
          item.id === cawId ? { ...item, ...updates } : item
        ))
      })

      // Refresh visible items in-place (re-fetch from server without resetting scroll)
      setFeedRefreshVisibleCallback(() => {
        const currentItems = itemsRef.current
        if (currentItems.length === 0) return
        // Refresh a sample of items (first 10) to avoid hammering the server
        const toRefresh = currentItems.slice(0, 10)
        for (const caw of toRefresh) {
          apiFetch<{ caw: CawItem }>(`/api/caws/${caw.id}`)
            .then(updated => {
              setItems(current => current.map(item =>
                item.id === caw.id ? { ...updated.caw } : item
              ))
            })
            .catch(() => {})
        }
      })

      return () => {
        setFeedRefreshCallback(null)
        setFeedItemUpdateCallback(null)
        setFeedRefreshVisibleCallback(null)
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

  // Fetch following count for current user when on Following or For You tab
  const needsFollowingCount = (filter === 'Following' || filter === 'For you') && !!activeToken?.username
  const { data: feedUserData } = useUserByUsername(needsFollowingCount ? activeToken?.username : undefined)
  useEffect(() => {
    if (!needsFollowingCount) {
      setFollowingCount(null)
      return
    }
    if (feedUserData) {
      setFollowingCount(feedUserData.followingCount)
    }
  }, [needsFollowingCount, feedUserData])

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

  // Unified polling for all pending states.
  // Uses itemsRef to avoid tearing down/recreating intervals on every items change,
  // which was causing cascading re-renders and UI flashing (e.g. SuggestedUsers).
  useEffect(() => {
    const interval = setInterval(async () => {
      const currentItems = itemsRef.current
      const toRefetch = currentItems.filter(item =>
        item.status === 'PENDING' || item.likePending || item.recawPending || item.replyPending || item.tipPending
      )
      if (toRefetch.length === 0) return

      for (const caw of toRefetch) {
        try {
          const updated = await apiFetch<{ caw: CawItem }>(`/api/caws/${caw.id}`)

          setItems(current =>
            current.map(item => {
              if (item.id !== caw.id) return item
              const freshCaw = updated.caw

              // Preserve pending flags until the action is actually confirmed
              return {
                ...freshCaw,
                likePending: caw.likePending ? (freshCaw.hasLiked ? false : true) : freshCaw.likePending,
                recawPending: caw.recawPending ? (freshCaw.hasRecawed ? false : true) : freshCaw.recawPending,
                replyPending: caw.replyPending ? (freshCaw.hasReplied ? false : true) : freshCaw.replyPending,
                tipPending: caw.tipPending ? (freshCaw.tipPending ?? false) : freshCaw.tipPending,
              }
            })
          )
        } catch {
          // Ignore errors
        }
      }
    }, 3000)

    return () => clearInterval(interval)
  }, []) // No dependencies — uses itemsRef

  // Stable callbacks for FeedItem state changes — use functional setItems so no deps needed
  const handleLikeStateChange = useCallback((cawId: string, likePending: boolean) => {
    setItems(current => current.map(item => item.id === cawId ? { ...item, likePending } : item))
  }, [])

  const handleRecawStateChange = useCallback((cawId: string, recawPending: boolean) => {
    setItems(current => current.map(item => item.id === cawId ? { ...item, recawPending } : item))
  }, [])

  const handleReplyStateChange = useCallback((cawId: string, replyPending: boolean) => {
    setItems(current => current.map(item => item.id === cawId ? { ...item, replyPending } : item))
  }, [])

  const handleTipStateChange = useCallback((cawId: string, tipPending: boolean) => {
    setItems(current => current.map(item => item.id === cawId ? { ...item, tipPending } : item))
  }, [])

  // Helper to refresh following count after a follow action
  // Don't reload the feed immediately — the follow is still processing on-chain.
  // Just update the following count; the feed will refresh naturally.
  const handleFollowChange = useCallback(() => {
    if (activeToken?.username) {
      qc.invalidateQueries({ queryKey: ['user', activeToken.username] })
    }
  }, [activeToken?.username])

  // render
  if (error) return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <div className="w-12 h-12 mb-4 rounded-full bg-red-500/10 flex items-center justify-center">
        <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
      </div>
      <p className="text-sm text-gray-400 mb-4">{error}</p>
      <button
        onClick={() => { setError(undefined); loadPage(true) }}
        className="px-5 py-2 text-sm font-medium rounded-full bg-white/10 text-white hover:bg-white/20 transition cursor-pointer"
      >
        Try again
      </button>
    </div>
  )
  const isOwnProfile = filter === 'profile' && username && activeToken?.username === username
  const showPending = (filter === 'For you' || filter === 'Following' || isOwnProfile) && pendingPosts.length > 0
  const hasPending = showPending

  if (items.length === 0 && loading && !hasPending) return (
    <div className="space-y-4 mt-4">
      {[...Array(3)].map((_, i) => (
        <div key={i} className="animate-pulse bg-gray-800 rounded-lg h-32"></div>
      ))}
    </div>
  )
  // Show suggested users on Following tab, or on For You tab when not following anyone
  const showSuggestedUsers = filter === 'Following' || (filter === 'For you' && followingCount === 0)

  if (items.length === 0 && !hasPending) {
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
  if (filteredItems.length === 0 && !hasPending) return <div className="text-gray-400 text-center py-8">No posts to show (some may be hidden by your settings).</div>

  return (
    <div>
      {/* Show suggested users at top when following < 10 people */}
      {showSuggestedUsers && (
        <div className={`border-b ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
          <SuggestedUsers onFollowChange={handleFollowChange} />
        </div>
      )}

      {/* Section title (rendered after suggested users) */}
      {title}

      {/* Show pending posts at the top */}
      {showPending && pendingPosts.map(post => (
        <FeedItem key={post.tempId} item={post as CawItem} />
      ))}

      {/* Posts with consistent styling across all pages */}
      {filteredItems.map((caw, idx) => {
        // Hide parent preview if the previous item is the parent post itself,
        // or another reply to the same parent
        const prevItem = idx > 0 ? filteredItems[idx - 1] : null
        const parentIsAbove = !!(caw.parent?.id && prevItem?.id === caw.parent.id)
        const sameParentAsPrev = !!(
          caw.parent?.id &&
          prevItem?.parent?.id &&
          caw.parent.id === prevItem.parent.id
        )
        const hidePreview = parentIsAbove || sameParentAsPrev
        return (
        <FeedItem
          key={caw.id}
          item={caw}
          hideParentPreview={hidePreview}
          onLikeStateChange={handleLikeStateChange}
          onRecawStateChange={handleRecawStateChange}
          onReplyStateChange={handleReplyStateChange}
          onTipStateChange={handleTipStateChange}
        />
        )
      })}

      {loading && <div className="py-4 text-center text-gray-400">Loading more…</div>}
      {!hasMore && <div className="py-4 text-center text-gray-500">You've reached the end.</div>}
    </div>
  )
})

Feed.displayName = 'Feed'

export default Feed


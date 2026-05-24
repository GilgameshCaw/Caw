// src/services/FrontEnd/src/components/Feed.tsx
import React, { useEffect, useLayoutEffect, useState, useCallback, forwardRef, useImperativeHandle, useMemo, useRef } from 'react'
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
import { useHiddenCawsStore } from '~/store/hiddenCawsStore'
import SuggestedUsers from './SuggestedUsers'
import { useHostVerification } from '~/hooks/useHostVerification'
import { useT } from '~/i18n/I18nProvider'
import { LoadingSpinner } from './Skeleton'
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

// Module-level cache so feed data survives component unmount/remount (navigation).
// Keyed by a string derived from feed parameters.
interface FeedCache {
  items: CawItem[]
  nextCursor?: number
  hasMore: boolean
  ts: number // timestamp for staleness check
}
const feedCache = new Map<string, FeedCache>()
const CACHE_TTL = 60_000 // 1 minute — background refresh if stale

// Per-feed scroll anchors, persisted across mount/unmount so navigating
// into a post and back returns the user to where they were in the feed.
// Anchors to the topmost visible item by id (with its viewport offset),
// not to a raw scrollY — that survives async image loads, layout shifts,
// and feed mutations. Keyed by the same cacheKey as feedCache.
//
// scrollY is captured as a backup: if the anchor element doesn't appear
// in the DOM within the retry budget (data still loading, item filtered
// out, etc.) we fall through to it. Bug #296 was the user landing at
// scrollY=0 on back-from-thread when the anchor restore failed silently.
type ScrollAnchor = { cawId: string; offset: number; scrollY: number }
const feedScrollAnchors = new Map<string, ScrollAnchor>()

// Session-scoped pins: replies the current user authored this session, keyed
// by parent id → confirmed reply ids. Used to keep an author's reply visually
// anchored below its parent even after the pending post transitions to a
// confirmed feed item. Fresh page loads clear this, restoring chronological
// order for everyone else.
const authoredInlineReplies = new Map<string, Set<string>>()

function feedCacheKey(filter: string, activeTokenId?: number, apiEndpoint?: string, username?: string): string {
  return `${filter}|${activeTokenId ?? ''}|${apiEndpoint ?? ''}|${username ?? ''}`
}

export interface FeedRef {
  refresh: () => void
}

const Feed = forwardRef<FeedRef, Props>(({ filter, username, apiEndpoint, title }, ref) => {
  const qc = useQueryClient()
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const activeToken = useTokenDataStore(s => {
    const tokens = Object.values(s.tokensByAddress).flat()
    return tokens.find(tk => tk.tokenId === s.activeTokenId) || tokens[0]
  })
  const pendingPosts = usePendingPostsStore(s => s.pendingPosts)
  const { isDark } = useTheme()
  const t = useT()
  const { preferences } = useMutePreferences()
  const blockedUsers = useBlockedUsersStore(s => s.blockedUsers)
  const hiddenCawonces = useHiddenCawsStore(s => s.hiddenCawonces)
  const hiddenRecaws = useHiddenCawsStore(s => s.hiddenRecaws)
  const cacheKey = feedCacheKey(filter, activeTokenId, apiEndpoint, username)
  const cached = feedCache.get(cacheKey)
  const [items,      setItems]      = useState<CawItem[]>(cached?.items ?? [])
  const [nextCursor, setNextCursor] = useState<number|undefined>(cached?.nextCursor)
  const [hasMore,    setHasMore]    = useState(cached?.hasMore ?? true)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState<string>()
  const [followingCount, setFollowingCount] = useState<number | null>(null)
  // Bump to force re-render when authoredInlineReplies is updated
  const [authoredPinVersion, setAuthoredPinVersion] = useState(0)

  // When the cache key changes (tab switch, navigation, etc.), restore from
  // cache or fetch fresh data. Using a ref to track the previous key so we
  // only act on actual changes, not re-renders.
  const prevCacheKeyRef = useRef(cacheKey)
  useEffect(() => {
    if (cacheKey === prevCacheKeyRef.current) return
    prevCacheKeyRef.current = cacheKey

    const c = feedCache.get(cacheKey)
    if (c && c.items.length > 0) {
      setItems(c.items)
      setNextCursor(c.nextCursor)
      setHasMore(c.hasMore)
    } else {
      setItems([])
      setNextCursor(undefined)
      setHasMore(true)
      // setLoading(true) here too — same reasoning as the cache-miss
      // branch in the other effect below. Without it, switching to a
      // tab with an empty cache flashes "No posts yet." while the
      // fetch is in flight.
      setLoading(true)
      setTimeout(() => loadPageRef.current?.(true), 0)
    }
  }, [cacheKey])

  // Ref to track current items without causing effect re-runs
  const itemsRef = useRef<CawItem[]>(items)
  useEffect(() => { itemsRef.current = items }, [items])

  // Restore/save scroll position by anchoring to the topmost visible feed
  // item (Twitter/X-style). On unmount or tab switch we record the id of
  // the post currently at the top of the viewport plus its offset; on
  // remount we find that element and align it to the same offset. Robust
  // to image loads and layout shifts because we anchor to a real DOM node.
  // Track the topmost visible feed item on every scroll so the anchor in
  // feedScrollAnchors is always up to date. Doing this on scroll (instead
  // of in a cleanup) avoids React 18 StrictMode's mount→cleanup→mount cycle
  // overwriting the saved value with whatever was at scrollY=0.
  useEffect(() => {
    let rafId: number | null = null
    const captureAnchor = () => {
      rafId = null
      const scrollY = window.scrollY
      const els = document.querySelectorAll<HTMLElement>('[data-caw-id]')
      for (const el of els) {
        const rect = el.getBoundingClientRect()
        if (rect.bottom > 0) {
          const cawId = el.getAttribute('data-caw-id')
          if (cawId) feedScrollAnchors.set(cacheKey, { cawId, offset: rect.top, scrollY })
          return
        }
      }
      // No visible feed item found (e.g., scrolled below the list) — still
      // record the raw scrollY so we can at least approximate on restore.
      const existing = feedScrollAnchors.get(cacheKey)
      if (existing) feedScrollAnchors.set(cacheKey, { ...existing, scrollY })
    }
    const onScroll = () => { if (rafId == null) rafId = requestAnimationFrame(captureAnchor) }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (rafId != null) cancelAnimationFrame(rafId)
    }
  }, [cacheKey])

  // Restore on mount by anchoring to the saved feed item. Retries via rAF
  // until the layout stabilizes (image loads etc. can shift heights for a
  // few frames after items render).
  //
  // Retry budget = 120 frames (~2s at 60fps). Previous 30 was too tight when
  // the feed data hadn't populated by the time the effect ran — the anchor
  // element wasn't in the DOM yet and we'd give up before it arrived,
  // leaving the user at scrollY=0 (bug #296). If we exhaust the budget
  // without finding the anchor element, fall back to the raw scrollY we
  // captured alongside the anchor — imperfect but better than scrolling
  // to top.
  useLayoutEffect(() => {
    const anchor = feedScrollAnchors.get(cacheKey)
    if (!anchor) return
    let cancelled = false
    let attempts = 0
    const MAX_ATTEMPTS = 120

    // Pre-emptively jump near the saved position so the user doesn't see
    // a flash at scrollY=0 while we're searching for the anchor element.
    // The anchor-based fine-tune below corrects any drift once the element
    // appears.
    if (anchor.scrollY > 0) window.scrollTo(0, anchor.scrollY)

    const tryRestore = () => {
      if (cancelled) return
      const el = document.querySelector<HTMLElement>(`[data-caw-id="${anchor.cawId}"]`)
      if (el) {
        const rect = el.getBoundingClientRect()
        const delta = rect.top - anchor.offset
        if (Math.abs(delta) > 1) {
          window.scrollBy(0, delta)
          if (++attempts < MAX_ATTEMPTS) requestAnimationFrame(tryRestore)
        }
        return
      }
      if (++attempts < MAX_ATTEMPTS) requestAnimationFrame(tryRestore)
      // If we time out without finding the element, the pre-emptive
      // scrollTo above is the fallback — we already landed there.
    }
    requestAnimationFrame(tryRestore)
    return () => { cancelled = true }
  }, [cacheKey])


  // Match pending posts to real caw IDs and clean up confirmed ones
  useEffect(() => {
    if (pendingPosts.length === 0 || items.length === 0) return
    const sig = (i: any) => `${i.user?.tokenId}:${(i.content || '').trim()}:${i.parent?.id || ''}`
    const confirmedSigs = new Set(
      items.filter(i => i.status !== 'PENDING').map(sig)
    )
    const { removePendingPost, updatePostId } = usePendingPostsStore.getState()
    let pinnedAdded = false
    for (const p of pendingPosts) {
      const parentId = p.replyToId || p.parent?.id
      // If the feed has the confirmed version, remove the pending post.
      // Before removing, pin the confirmed reply under its parent so the
      // author's own fresh reply stays visually anchored instead of
      // teleporting to the top of the feed.
      if (confirmedSigs.has(sig(p))) {
        if (parentId) {
          const confirmed = items.find(i => i.status !== 'PENDING' && sig(i) === sig(p))
          if (confirmed) {
            const set = authoredInlineReplies.get(parentId) || new Set<string>()
            if (!set.has(confirmed.id)) {
              set.add(confirmed.id)
              authoredInlineReplies.set(parentId, set)
              pinnedAdded = true
            }
          }
        }
        removePendingPost(p.tempId)
        continue
      }
      // If the pending post still has a temp ID, try to resolve it from
      // the feed items (matched by cawonce + userId — the DB row exists
      // immediately as PENDING, so the feed usually has it)
      if (String(p.id).startsWith('pending-') && p.cawonce && p.user?.tokenId) {
        const match = items.find(
          i => i.cawonce === p.cawonce && i.user?.tokenId === p.user?.tokenId
        )
        if (match && !String(match.id).startsWith('pending-')) {
          updatePostId(p.cawonce, p.user.tokenId, match.id)
        }
      }
    }
    if (pinnedAdded) setAuthoredPinVersion(v => v + 1)
  }, [items, pendingPosts])

  // Filter items based on mute preferences and blocked users
  const filteredItems = useMemo(() => {
    const blockedUserIds = blockedUsers.map(u => u.tokenId)
    // Build a set of pending post signatures (content + userId + parentId) to dedupe DB pending posts
    const pendingSig = (p: any) => `${p.user?.tokenId}:${(p.content || '').trim()}:${p.parent?.id || ''}`
    const pendingPostSignatures = new Set(pendingPosts.map(pendingSig))

    const isReply = (it: CawItem) => it.parent?.id && !it.isQuote && it.action !== 'RECAW'
    const isHomeFeed = filter === 'For you' || filter === 'Following'
    // On the home feeds, dedupe by "underlying caw" so the same post never
    // appears twice no matter how it surfaces — bare recaw + original + a
    // quote of it all collapse to the FIRST occurrence in desc order. The
    // quote/recaw wrapper IS the surface kept on screen when it's first,
    // so the user still sees who quoted; subsequent occurrences (whether
    // another recaw, another quote, or the original itself) drop out.
    const seenUnderlying = new Set<string>()

    const filtered = items.filter(item => {
      // Filter out muted content
      if (shouldFilterPost(item, preferences)) return false
      // Filter out blocked users
      if (blockedUserIds.includes(item.user.tokenId)) return false
      // Main timeline feeds should not show replies — they belong on the post page.
      if (isHomeFeed && isReply(item)) return false
      // Filter out posts the current user just deleted — the on-chain hide
      // takes 5–60s to land, this keeps them gone immediately.
      if (item.cawonce != null && item.user?.tokenId != null &&
          hiddenCawonces[`${item.user.tokenId}:${Number(item.cawonce)}`]) return false
      // Filter out plain recaws the current user just undid. Quotes are
      // standalone posts and aren't deleted by `hide:recaw:*` — skip them.
      if (item.action === 'RECAW' && !item.isQuote && item.parent &&
          item.user?.tokenId != null && item.parent.user?.tokenId != null && item.parent.cawonce != null &&
          hiddenRecaws[`${item.user.tokenId}:${item.parent.user.tokenId}:${Number(item.parent.cawonce)}`]) return false
      // Filter out DB PENDING posts that match local pending posts (same user + content + parent)
      if (item.status === 'PENDING') {
        if (pendingPostSignatures.has(pendingSig(item))) return false
      }
      if (isHomeFeed) {
        // Quotes ARE RECAW rows with content; bare recaws are RECAW
        // rows with empty content. Both reference an underlying
        // (parent) caw — collapse against it. Regular caws collapse
        // against their own id. First occurrence wins, all later
        // occurrences (recaw, quote, or the original) are dropped.
        const underlyingId = item.action === 'RECAW' ? (item.parent?.id ?? item.id) : item.id
        if (seenUnderlying.has(underlyingId)) return false
        seenUnderlying.add(underlyingId)
      }
      return true
    })

    // Hoist a reply down so it renders right under its parent post, leaving
    // every other item (quotes, unrelated posts) at its natural desc position.
    // The feed comes in desc order, so a reply written AFTER its parent
    // appears BEFORE it in the array; we want the visual to be:
    //
    //   ...other newer posts...
    //   [original post]
    //   [reply 1, reply 2, ...]
    //   ...older posts...
    //
    // Quotes (RECAW with content) are NOT replies — they share parent.id but
    // visually they're standalone posts. They keep their natural position so
    // a desc feed shows quote → original → reply, not original → quote → reply.
    //
    // Algorithm: walk desc-order, build the result preserving each item's
    // natural position UNLESS it's a reply whose parent appears later in the
    // window. In that case skip it for now and re-emit it the moment we
    // place its parent. Replies whose parent isn't in the nearby window are
    // dropped at their natural position (don't promote orphans).
    const PARENT_LOOKAHEAD = 8
    // Map parentId -> queued replies waiting to be emitted under it.
    const pendingByParent = new Map<string, CawItem[]>()
    const result: CawItem[] = []
    for (let i = 0; i < filtered.length; i++) {
      const item = filtered[i]

      if (isReply(item)) {
        // Look ahead for the parent post within the window. If found,
        // hold this reply until we emit the parent.
        const parentId = item.parent!.id
        let parentFoundAhead = false
        for (let k = i + 1; k < filtered.length && k <= i + PARENT_LOOKAHEAD; k++) {
          if (filtered[k].id === parentId) { parentFoundAhead = true; break }
        }
        if (parentFoundAhead) {
          const list = pendingByParent.get(parentId) || []
          list.push(item)
          pendingByParent.set(parentId, list)
          continue
        }
        // Parent not nearby — emit reply at natural position.
      }

      result.push(item)

      // If this item is a parent of any queued replies, emit them now,
      // sorted by cawonce ascending so 1/N renders before 2/N.
      const queued = pendingByParent.get(item.id)
      if (queued && queued.length) {
        queued.sort((a, b) => (a.cawonce ?? 0) - (b.cawonce ?? 0))
        result.push(...queued)
        pendingByParent.delete(item.id)
      }
    }
    // Anything still in pendingByParent didn't find its parent (lookahead
    // ran out) — emit at end so we don't lose them.
    for (const queued of pendingByParent.values()) {
      result.push(...queued)
    }
    return result
  }, [items, preferences, blockedUsers, pendingPosts, hiddenCawonces, hiddenRecaws])

  // Expose refresh method via ref
  useImperativeHandle(ref, () => ({
    refresh: () => {
      feedCache.delete(cacheKey)
      setItems([])
      setNextCursor(undefined)
      setHasMore(true)
      loadPage(true)
    }
  }), [cacheKey])

  // Spot-check posts against on-chain data to detect dishonest API hosts
  // Memoize to avoid creating new arrays on every render
  const verificationItems = useMemo(() => filteredItems.map(item => ({
    user: { tokenId: item.user?.tokenId || 0 },
    cawonce: item.cawonce || 0,
    content: item.content,
    status: item.status,
  })), [filteredItems])
  useHostVerification(verificationItems)

  // Track views for visible caws (memoize to avoid re-triggering on every render).
  // Bare recaws (RECAW action with empty content) are wrappers — the impression
  // belongs to the underlying original, not the recaw row, otherwise a popular
  // post that gets surfaced via 100+ recaws ends up with views split across
  // every wrapper while its own viewCount stays near zero. Quote-recaws (RECAW
  // with content) are standalone posts with their own engagement, so they
  // keep their own id.
  const visibleCawIds = useMemo(() => filteredItems
    .map(item => {
      const isBareRecaw = item.action === 'RECAW' && !item.isQuote && item.parent?.id
      return Number(isBareRecaw ? item.parent.id : item.id)
    })
    .filter(id => Number.isFinite(id)), [filteredItems])
  useViewTracking(visibleCawIds)

  // Refs for loadPage to always read current props (avoids stale closures)
  const loadPageRef = useRef<((force?: boolean) => Promise<void>) | null>(null)
  const apiEndpointRef = useRef(apiEndpoint)
  apiEndpointRef.current = apiEndpoint
  const filterRef = useRef(filter)
  filterRef.current = filter
  const usernameRef = useRef(username)
  usernameRef.current = username
  const loadingRef = useRef(false)

  // load one "page" of results — reads props from refs to avoid stale closures
  const loadPage = useCallback(async (force = false) => {
    // When force is true (navigation/refresh), skip the loading guard —
    // the previous fetch for a different endpoint is irrelevant.
    if (!force && (loadingRef.current || !hasMore)) return
    loadingRef.current = true
    setLoading(true)
    setError(undefined)

    const currentApiEndpoint = apiEndpointRef.current
    const currentFilter = filterRef.current
    const currentUsername = usernameRef.current
    const currentTokenId = useTokenDataStore.getState().activeTokenId
    const cursorToUse = force ? undefined : nextCursor

    // Use custom API endpoint if provided (for hashtag feeds)
    if (currentApiEndpoint) {
      const params = new URLSearchParams()
      if (cursorToUse != null) {
        const paramName = currentApiEndpoint.includes('/search') ? 'offset' : 'cursor'
        params.set(paramName, String(cursorToUse))
      }

      try {
        const separator = currentApiEndpoint.includes('?') ? '&' : '?'
        const url = params.toString()
          ? `${currentApiEndpoint}${separator}${params.toString()}`
          : currentApiEndpoint

        const response = await apiFetch<FeedResponse>(url)
        const newItems = response.items || []
        const newCursor = response.nextCursor

        const finalHasMore = newCursor != null
        setItems(current => {
          const merged = force ? newItems : [...current, ...newItems]
          const key = feedCacheKey(currentFilter, currentTokenId, currentApiEndpoint, currentUsername)
          if (merged.length > 0) feedCache.set(key, { items: merged, nextCursor: newCursor, hasMore: finalHasMore, ts: Date.now() })
          return merged
        })
        setNextCursor(newCursor)
        setHasMore(finalHasMore)
      } catch (err: any) {
        console.error('Custom feed load error', err)
        setError(t('feed.error.failed_to_load'))
      } finally {
        loadingRef.current = false; setLoading(false)
      }
      return
    }

    // Default caws API logic
    const params = new URLSearchParams()
    if (currentFilter === 'Following') {
      params.set('filter', 'following')
    }
    if (currentFilter === 'profile' && currentUsername) {
      params.set('user', currentUsername)
    }
    if (currentFilter === 'profile-likes' && currentUsername) {
      params.set('user', currentUsername)
      params.set('filter', 'liked')
    }
    if (currentFilter === 'profile-media' && currentUsername) {
      params.set('user', currentUsername)
      params.set('filter', 'media')
    }
    if (currentFilter === 'profile-replies' && currentUsername) {
      params.set('user', currentUsername)
      params.set('filter', 'replies')
    }

    if (cursorToUse != null) {
      params.set('cursor', String(cursorToUse))
    }

    try {
      const { items: newItems, nextCursor: newCursor } =
        await apiFetch<FeedResponse>(`/api/caws?${params.toString()}`)

      const finalHasMore = newCursor != null
      setItems(current => {
        const base = force ? [] : current
        const seen = new Set<string>()
        const merged = [...base, ...newItems]
          .filter(item => {
            if (seen.has(item.id)) return false
            seen.add(item.id)
            return true
          })
        const key = feedCacheKey(currentFilter, currentTokenId, currentApiEndpoint, currentUsername)
        if (merged.length > 0) feedCache.set(key, { items: merged, nextCursor: newCursor, hasMore: finalHasMore, ts: Date.now() })
        return merged
      })

      if (newCursor != null) {
        setNextCursor(newCursor)
      } else {
        setHasMore(false)
      }
    } catch (e) {
      console.error(e)
      setError(t('feed.error.could_not_load'))
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [nextCursor, hasMore])

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

      // Refresh visible items in-place (re-fetch from server without resetting scroll).
      // Debounced so rapid-fire callers (e.g. txqueue monitor resolving many actions
      // in one poll cycle) only trigger one refresh burst.
      let refreshTimer: ReturnType<typeof setTimeout> | null = null
      setFeedRefreshVisibleCallback(() => {
        if (refreshTimer) clearTimeout(refreshTimer)
        refreshTimer = setTimeout(() => {
          refreshTimer = null
          const currentItems = itemsRef.current
          if (currentItems.length === 0) return
          // Refresh a sample of items (first 10) to avoid hammering the server
          const toRefresh = currentItems.slice(0, 10)
          for (const caw of toRefresh) {
            apiFetch<{ caw: CawItem }>(`/api/caws/${caw.id}`)
              .then(updated => {
                // Preserve `isPinned` on merge: that flag is set by the
                // profile-feed prepend logic (or our own optimistic
                // path), not by the single-caw endpoint. Spreading
                // `updated.caw` raw would wipe the badge.
                setItems(current => current.map(item =>
                  item.id === caw.id
                    ? { ...updated.caw, isPinned: item.isPinned ?? updated.caw.isPinned }
                    : item
                ))
              })
              .catch(() => {})
          }
        }, 1000)
      })

      return () => {
        setFeedRefreshCallback(null)
        setFeedItemUpdateCallback(null)
        setFeedRefreshVisibleCallback(null)
      }
    }
  }, [filter])

  // when filter, user, or endpoint changes, restore from cache if available,
  // otherwise reset. Always refetch — reaction data (hasLiked, etc.) is per-user
  // and may be stale even if the posts themselves haven't changed.
  const prevTokenIdRef = useRef(activeTokenId)
  useEffect(() => {
    const userChanged = prevTokenIdRef.current !== activeTokenId
    prevTokenIdRef.current = activeTokenId

    const key = feedCacheKey(filter, activeTokenId, apiEndpoint, username)
    const c = feedCache.get(key)
    if (c && c.items.length > 0 && !userChanged) {
      // Restore cached data — no skeleton flash
      setItems(c.items)
      setNextCursor(c.nextCursor)
      setHasMore(c.hasMore)
      setLoading(false)
      // Background refresh if cache is stale
      if (Date.now() - c.ts > CACHE_TTL) {
        setTimeout(() => loadPageRef.current?.(true), 0)
      }
    } else {
      // User changed or no cache — clear and refetch. setLoading(true)
      // here, not false: we're about to fetch, and the empty render
      // window between this effect and loadPage's own setLoading(true)
      // was flashing "No posts yet." for first-time visitors to /home
      // (e.g. landed on a caw page via shared link, then clicked the
      // logo). Setting loading first means the empty branch hits the
      // spinner check at line ~703 instead of the empty-state text.
      if (userChanged) feedCache.delete(key)
      setItems([])
      setNextCursor(undefined)
      setHasMore(true)
      setLoading(true)
      setTimeout(() => loadPageRef.current?.(true), 0)
    }
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

  // Optimistic pin reorder for snappy UX. The server-side optimistic
  // write (in /api/actions) is what makes pins survive a refresh; this
  // is purely the in-memory rearrange so the post visibly moves up
  // before the next refetch lands. Stamps `pinPending: true` so the
  // FeedItem can render the pending spinner without waiting on data.
  const handlePinUpdate = useCallback((cawId: string, isPinned: boolean) => {
    setItems(current => {
      const updated = current.map(item =>
        item.id === cawId
          ? { ...item, isPinned, pinPending: true }
          : item
      )
      if (!isPinned) return updated
      // Pin: extract the target and prepend so it visually moves to top.
      const target = updated.find(i => i.id === cawId)
      if (!target) return updated
      const rest = updated.filter(i => i.id !== cawId)
      return [target, ...rest]
    })
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
  const isOwnProfile = (filter === 'profile' || filter === 'profile-replies') && username && activeToken?.username === username
  const hashtagFilter = typeof filter === 'string' && filter.startsWith('hashtag:') ? filter.slice('hashtag:'.length).toLowerCase() : null
  const showPending = (filter === 'For you' || filter === 'Following' || isOwnProfile || !!hashtagFilter) && pendingPosts.length > 0
  const hasPending = showPending

  if (items.length === 0 && loading && !hasPending) return <LoadingSpinner />
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
    return <div className="text-gray-400 text-center py-8">{t('feed.empty.no_posts')}</div>
  }
  if (filteredItems.length === 0 && !hasPending) return <div className="text-gray-400 text-center py-8">{t('feed.empty.all_filtered')}</div>

  return (
    <div>
      {/* Show suggested users at top when following < 10 people */}
      {showSuggestedUsers && (
        <div className="my-4">
          <SuggestedUsers onFollowChange={handleFollowChange} />
        </div>
      )}

      {/* Section title (rendered after suggested users) */}
      {title}

      {/* Render pending posts. Top-level pending posts (no parent) render at
          the top of the feed. Pending replies render inline beneath their
          parent if the parent is in the feed; otherwise fall back to the top.
          Confirmed replies the author pinned this session (authoredInlineReplies)
          also render inline and are hoisted out of their chronological slot. */}
      {((_v: number) => {
        const sig = (i: any) => `${i.user?.tokenId}:${(i.content || '').trim()}:${i.parent?.id || ''}`
        const confirmedSigs = new Set(items.filter(i => i.status !== 'PENDING').map(sig))
        const feedIds = new Set(filteredItems.map(i => i.id))

        // Collect confirmed replies that should pin inline under their parent
        const pinnedInlineByParent = new Map<string, CawItem[]>()
        const hoistedIds = new Set<string>()
        for (const [parentId, replyIdSet] of authoredInlineReplies.entries()) {
          if (!feedIds.has(parentId)) continue
          const arr: CawItem[] = []
          for (const rid of replyIdSet) {
            const match = filteredItems.find(i => i.id === rid)
            if (match) { arr.push(match); hoistedIds.add(rid) }
          }
          if (arr.length) pinnedInlineByParent.set(parentId, arr)
        }

        const visiblePending = showPending
          ? pendingPosts
              // Main feeds: don't render pending replies either.
              .filter(p => (filter === 'For you' || filter === 'Following') ? !(p.replyToId || p.parent?.id) : true)
              .filter(p => filter === 'profile-replies' ? !!p.replyToId : true)
              .filter(p => {
                if (!hashtagFilter) return true
                const tag = '#' + hashtagFilter
                const content = (p.content || '').toLowerCase()
                return content.split(/\s+/).some(w => w.replace(/[.,!?;:)]+$/, '') === tag)
              })
              .filter(p => !confirmedSigs.has(sig(p)))
          : []

        // Build maps so a pending reply can find its pending parent (within
        // the same thread submission). replyToId points at the parent's
        // tempId; once the parent confirms, its id swaps to the real DB id
        // but tempId stays — so we keep tempId as the key.
        const pendingByTempId = new Map<string, any>()
        for (const p of visiblePending) {
          if (p.tempId) pendingByTempId.set(p.tempId, p)
        }

        // Resolve a pending parent reference (tempId in replyToId) against
        // the confirmed feed when the parent has since confirmed. We match
        // on (cawonce, tokenId) — a stable identity that survives the
        // pending→confirmed swap. Without this, 2/2 lands in pendingAtTop
        // while 1/2 sits in filteredItems, and the user sees them inverted.
        const confirmedIdByCawonce = new Map<string, string>()
        for (const c of filteredItems) {
          if (c.cawonce != null && c.user?.tokenId != null) {
            confirmedIdByCawonce.set(`${c.user.tokenId}:${c.cawonce}`, c.id)
          }
        }
        const resolveParent = (p: any): { kind: 'confirmed' | 'pending' | 'none', id?: string } => {
          const pid = p.replyToId || p.parent?.id
          if (!pid) return { kind: 'none' }
          if (feedIds.has(pid)) return { kind: 'confirmed', id: pid }
          if (pendingByTempId.has(pid)) return { kind: 'pending', id: pid }
          // replyToId is a tempId of a parent that's no longer pending —
          // try to match it to a confirmed item via the parent CawItem we
          // captured at compose time (carries the real cawonce).
          const parentCawonce = p.parent?.cawonce
          const parentTokenId = p.parent?.user?.tokenId
          if (parentCawonce != null && parentTokenId != null) {
            const realId = confirmedIdByCawonce.get(`${parentTokenId}:${parentCawonce}`)
            if (realId) return { kind: 'confirmed', id: realId }
          }
          return { kind: 'none' }
        }

        // Group pending replies by their parent. A parent can be (a) a
        // confirmed item already in the feed, or (b) another pending post
        // submitted moments earlier in the same thread.
        const pendingRepliesByConfirmedParent = new Map<string, any[]>()
        const pendingRepliesByPendingParent = new Map<string, any[]>()
        const pendingAtTop: any[] = []
        for (const p of visiblePending) {
          const r = resolveParent(p)
          if (r.kind === 'none') {
            pendingAtTop.push(p)
          } else if (r.kind === 'confirmed') {
            const arr = pendingRepliesByConfirmedParent.get(r.id!) || []
            arr.push(p)
            pendingRepliesByConfirmedParent.set(r.id!, arr)
          } else {
            const arr = pendingRepliesByPendingParent.get(r.id!) || []
            arr.push(p)
            pendingRepliesByPendingParent.set(r.id!, arr)
          }
        }

        // Build the at-top render list. Each "root" pending post (in
        // pendingAtTop) carries its own inline pending replies if any.
        // Sort by cawonce ascending — every pending post was assigned its
        // real cawonce by the API at submit time (PostForm.tsx:1171), so
        // it's a stable monotonically-increasing submission-order key.
        // Falling back to timestamp loses ties when a multi-chunk thread
        // is signed in the same millisecond (1/3, 2/3, 3/3 all share
        // a timestamp), which previously rendered the run out of order.
        const byCawonce = (a: any, b: any) => (a.cawonce ?? 0) - (b.cawonce ?? 0)
        const renderPendingAtTop = [...pendingAtTop].sort(byCawonce)
        const sortPendingChildren = (arr: any[]) => [...arr].sort(byCawonce)

        // At render time, resolve any pending post whose `id` still starts
        // with `pending-` against the server-fetched feed via (cawonce,
        // tokenId). When the server-side row is already in `items` with
        // its real id, swap it in here so the FeedItem click navigates
        // to `/users/<u>/caw/<id>-<slug>` — not `/caws/pending-…`. The
        // effect at line 211 also does this swap eventually but renders
        // BETWEEN server response and that effect running otherwise leak
        // the pending URL to clicks. Stable id (no swap) when no match.
        const resolveRealId = (p: any): any => {
          const idStr = String(p.id || '')
          if (!idStr.startsWith('pending-')) return p
          if (p.cawonce == null || !p.user?.tokenId) return p
          const match = items.find(
            i => i.cawonce === p.cawonce && i.user?.tokenId === p.user?.tokenId,
          )
          if (!match || String(match.id).startsWith('pending-')) return p
          return { ...p, id: match.id }
        }

        return (
          <>
            {renderPendingAtTop.map(post => {
              const inlineUnderPending = sortPendingChildren(
                pendingRepliesByPendingParent.get(post.tempId) || []
              )
              const resolved = resolveRealId(post)
              return (
                <React.Fragment key={post.tempId}>
                  <FeedItem item={resolved as CawItem} />
                  {inlineUnderPending.map(child => (
                    <FeedItem key={child.tempId} item={resolveRealId(child) as CawItem} hideParentPreview />
                  ))}
                </React.Fragment>
              )
            })}

            {/* Posts with consistent styling across all pages */}
            {filteredItems.map((caw, idx) => {
              // Skip items hoisted inline under a parent elsewhere in the feed
              if (hoistedIds.has(caw.id)) return null
              // Hide parent preview if the previous item is the parent post itself,
              // or another reply to the same parent. Quotes (RECAW with content)
              // share parent.id with replies but render as standalone posts —
              // treating a quote-then-reply pair as a "reply chain" makes the
              // reply look like a reply to the quote, hiding its real target.
              const prevItem = idx > 0 ? filteredItems[idx - 1] : null
              const prevIsReply = !!(
                prevItem?.parent?.id &&
                !prevItem.isQuote &&
                prevItem.action !== 'RECAW'
              )
              const parentIsAbove = !!(caw.parent?.id && prevItem?.id === caw.parent.id)
              const sameParentAsPrev = prevIsReply && caw.parent?.id === prevItem!.parent!.id
              const hidePreview = parentIsAbove || sameParentAsPrev
              const inlinePending = sortPendingChildren(pendingRepliesByConfirmedParent.get(caw.id) || [])
              const inlinePinned = pinnedInlineByParent.get(caw.id) || []
              return (
                <React.Fragment key={caw.id}>
                  <FeedItem
                    item={caw}
                    hideParentPreview={hidePreview}
                    onLikeStateChange={handleLikeStateChange}
                    onRecawStateChange={handleRecawStateChange}
                    onReplyStateChange={handleReplyStateChange}
                    onTipStateChange={handleTipStateChange}
                    onPinUpdate={handlePinUpdate}
                  />
                  {inlinePinned.map(reply => (
                    <FeedItem
                      key={reply.id}
                      item={reply}
                      hideParentPreview
                      onLikeStateChange={handleLikeStateChange}
                      onRecawStateChange={handleRecawStateChange}
                      onReplyStateChange={handleReplyStateChange}
                      onTipStateChange={handleTipStateChange}
                      onPinUpdate={handlePinUpdate}
                    />
                  ))}
                  {inlinePending.map(post => (
                    <FeedItem key={post.tempId} item={resolveRealId(post) as CawItem} hideParentPreview />
                  ))}
                </React.Fragment>
              )
            })}
          </>
        )
      })(authoredPinVersion)}

      {loading && <div className="py-4 text-center text-gray-400">{t('feed.loading_more')}</div>}
      {!hasMore && <div className="py-4 text-center text-gray-500">You've reached the end.</div>}
    </div>
  )
})

Feed.displayName = 'Feed'

export default Feed

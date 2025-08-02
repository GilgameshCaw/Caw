// src/services/FrontEnd/src/components/Feed.tsx
import React, { useEffect, useState, useCallback } from 'react'
import { useTokenDataStore } from '~/store/tokenDataStore'
import FeedItem from './FeedItem'
import { apiFetch } from '../api/client'
import { User, CawItem } from '~/types'

type Props = {
  filter: 'For you' | 'Following' | 'profile' | 'profile-likes'
  username?: string
}


// whatever shape your backend now returns

type FeedResponse = {
  items: CawItem[]
  nextCursor?: number
}

const Feed: React.FC<Props> = ({ filter, username }) => {
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const [items,      setItems]      = useState<CawItem[]>([])
  const [nextCursor, setNextCursor] = useState<number|undefined>(undefined)
  const [hasMore,    setHasMore]    = useState(true)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState<string>()

  // load one “page” of results
  const loadPage = useCallback(async (force = false) => {
    if (loading || (!hasMore && !force)) return
    setLoading(true)
    setError(undefined)

    const cursorToUse = force ? undefined : nextCursor
    const params = new URLSearchParams()
    if (filter === 'Following') {
      params.set('filter', 'following')
    }
    // new profile‐only:
    if (filter === 'profile' && username) {
      // Fetch only this user’s posts
      params.set('user', username)
    }

    // new profile‐likes:
    if (filter === 'profile-likes' && username) {
      // Fetch only this user’s liked posts
      params.set('user', username)
      params.set('filter', 'liked')
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
  }, [filter, nextCursor, hasMore, loading])

  // when filter changes, reset everything & load first page
  useEffect(() => {
    setItems([])
    setNextCursor(undefined)
    setHasMore(true)
    loadPage(true)
  }, [filter, activeTokenId])

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

  // render
  if (error)   return <div className="text-red-500">{error}</div>
  if (items.length === 0 && loading) return <div>Loading…</div>
  if (items.length === 0)             return <div>No posts yet.</div>

  return (
    <div>
      {items.map(caw => (
        <FeedItem
          key={caw.id}
          item={caw}
        />
      ))}

      {loading && <div className="py-4 text-center">Loading more…</div>}
      {!hasMore && <div className="py-4 text-center">You’ve reached the end.</div>}
    </div>
  )
}

export default Feed


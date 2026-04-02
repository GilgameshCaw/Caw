import React, { useState, useEffect, useCallback } from 'react'
import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { HiOutlineSearch, HiOutlineInformationCircle } from 'react-icons/hi'
import FeedItem from '~/components/FeedItem'
import type { CawItem } from '~/types'
import { apiFetch } from '~/api/client'

const BookmarksPage: React.FC = () => {
  const { isDark } = useTheme()
  const [searchQuery, setSearchQuery] = useState('')
  const [bookmarkedPosts, setBookmarkedPosts] = useState<CawItem[]>([])
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<number | undefined>(undefined)
  const [loadingMore, setLoadingMore] = useState(false)

  const fetchBookmarks = useCallback(async (cursor?: number) => {
    try {
      const params = new URLSearchParams({ limit: '20' })
      if (cursor) params.set('cursor', String(cursor))

      const data = await apiFetch<{
        bookmarks: CawItem[]
        hasMore: boolean
        nextCursor?: number
      }>(`/api/bookmarks?${params}`)

      if (cursor) {
        setBookmarkedPosts(prev => [...prev, ...data.bookmarks])
      } else {
        setBookmarkedPosts(data.bookmarks)
      }
      setHasMore(data.hasMore)
      setNextCursor(data.nextCursor)
    } catch (error) {
      console.error('Failed to fetch bookmarks:', error)
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [])

  useEffect(() => {
    fetchBookmarks()
  }, [fetchBookmarks])

  const loadMore = () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    fetchBookmarks(nextCursor)
  }

  const handleBookmarkUpdate = (cawId: number, isBookmarked: boolean) => {
    if (!isBookmarked) {
      setBookmarkedPosts(prev => prev.filter(caw => Number(caw.id) !== cawId))
    }
  }

  // Filter bookmarks based on search query
  const filteredPosts = searchQuery
    ? bookmarkedPosts.filter(post =>
        post.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
        post.user.username.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : bookmarkedPosts

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4 bg-black">
        {/* Bookmarks Header */}
        <div className="mb-6">
          <h1 className={`text-2xl font-bold transition-colors duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            Bookmarks
          </h1>
          <div className={`flex items-center gap-2 mt-2 text-sm ${
            isDark ? 'text-gray-400' : 'text-gray-500'
          }`}>
            <HiOutlineInformationCircle className="w-4 h-4" />
            <span>Bookmarks are saved to your account on this client.</span>
          </div>
        </div>

        {/* Search Bar */}
        <div className="mb-6">
          <div className="relative">
            <HiOutlineSearch className={`absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-500'
            }`} />
            <input
              type="text"
              placeholder="Search bookmarks"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={`w-full pl-10 pr-4 py-3 rounded-full border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-gray-500/30 ${
                isDark
                  ? 'bg-black border-gray-600 text-white placeholder-gray-400 focus:bg-transparent'
                  : 'bg-white border-gray-300 text-black placeholder-gray-500 focus:bg-transparent'
              }`}
            />
          </div>
        </div>

        {/* Bookmarked Posts */}
        {loading && bookmarkedPosts.length === 0 ? (
          <div className="animate-pulse space-y-4">
            {[1, 2, 3].map(i => (
              <div key={i} className={`p-4 rounded-lg ${isDark ? 'bg-white/5' : 'bg-gray-100'}`}>
                <div className={`h-4 ${isDark ? 'bg-white/10' : 'bg-gray-200'} rounded mb-2`} />
                <div className={`h-4 ${isDark ? 'bg-white/10' : 'bg-gray-200'} rounded w-3/4`} />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-0">
            {filteredPosts.map((post) => (
              <FeedItem
                key={post.id}
                item={post}
                onBookmarkUpdate={handleBookmarkUpdate}
              />
            ))}
          </div>
        )}

        {/* Load more */}
        {hasMore && !loading && (
          <div className="flex justify-center py-4">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className={`px-6 py-2 rounded-lg text-sm font-medium transition cursor-pointer ${
                isDark ? 'bg-white/10 hover:bg-white/20 text-white' : 'bg-gray-100 hover:bg-gray-200 text-gray-900'
              } disabled:opacity-50`}
            >
              {loadingMore ? 'Loading...' : 'Load more'}
            </button>
          </div>
        )}

        {/* Empty State */}
        {!loading && bookmarkedPosts.length === 0 && (
          <div className="text-center py-12">
            <div className={`w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center ${
              isDark ? 'bg-gray-800' : 'bg-gray-200'
            }`}>
              <span className="text-2xl">🔖</span>
            </div>
            <h3 className={`text-lg font-semibold mb-2 transition-colors duration-300 ${
              isDark ? 'text-white' : 'text-black'
            }`}>
              No bookmarks yet
            </h3>
            <p className={`transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`}>
              Save posts you want to read later by clicking the bookmark icon.
            </p>
            <p className={`text-sm mt-2 transition-colors duration-300 ${
              isDark ? 'text-gray-500' : 'text-gray-400'
            }`}>
              Bookmarks are tied to your account on this client.
            </p>
          </div>
        )}
      </div>
    </MainLayout>
  )
}

export default BookmarksPage

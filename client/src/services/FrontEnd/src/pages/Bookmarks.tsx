import React, { useState, useEffect } from 'react'
import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { HiOutlineSearch, HiOutlineInformationCircle } from 'react-icons/hi'
import FeedItem from '~/components/FeedItem'
import type { CawItem } from '~/types'
import MobilePostModal from '~/components/MobilePostModal'
import { useAccount } from "wagmi"
import { useConnectModal } from "@rainbow-me/rainbowkit"
import { HiOutlinePlus } from "react-icons/hi"
import { BsWallet } from 'react-icons/bs'
import { apiFetch } from '~/api/client'
import { useBookmarksStore } from '~/store/bookmarksStore'

const BookmarksPage: React.FC = () => {
  const { isDark } = useTheme()
  const [searchQuery, setSearchQuery] = useState('')
  const [isMobilePostModalOpen, setIsMobilePostModalOpen] = useState(false)
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()

  // Bookmarks are stored in localStorage (browser-only)
  const bookmarkedIds = useBookmarksStore(state => state.bookmarkedCawIds)
  const removeBookmark = useBookmarksStore(state => state.removeBookmark)

  const [bookmarkedPosts, setBookmarkedPosts] = useState<CawItem[]>([])
  const [loading, setLoading] = useState(true)

  const fetchBookmarks = async () => {
    if (bookmarkedIds.length === 0) {
      setBookmarkedPosts([])
      setLoading(false)
      return
    }

    try {
      // Convert string IDs to numbers for the API
      const numericIds = bookmarkedIds.map(id => parseInt(id)).filter(id => !isNaN(id))

      const data = await apiFetch('/api/caws/by-ids', {
        method: 'POST',
        body: JSON.stringify({ ids: numericIds })
      })

      const { items } = data

      // Transform the data to match CawItem format
      const transformedItems = items.map((item: any) => ({
        ...item,
        id: item.id.toString(),
        timestamp: item.createdAt,
        isBookmarked: true,
        hashtags: item.hashtags?.map((h: any) => h.hashtag) || []
      }))

      setBookmarkedPosts(transformedItems)
    } catch (error) {
      console.error('Failed to fetch bookmarks:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchBookmarks()
  }, [bookmarkedIds])

  const handleBookmarkUpdate = (cawId: number, isBookmarked: boolean) => {
    if (!isBookmarked) {
      // Remove from list when unbookmarked (store already updated by FeedItem)
      setBookmarkedPosts(prev => prev.filter(caw => caw.id !== cawId.toString()))
    }
  }

  // Filter bookmarks based on search query
  const filteredPosts = bookmarkedPosts.filter(post =>
    post.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
    post.user.username.toLowerCase().includes(searchQuery.toLowerCase())
  )

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
            <span>Bookmarks are stored in your browser and are private to you.</span>
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

        {/* Empty State (if no bookmarks) */}
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
              Bookmarks are stored locally in your browser.
            </p>
          </div>
        )}
      </div>

      {/* Floating Action Button - Mobile only */}
      <div className="md:hidden fixed bottom-20 right-12 z-30 transform-none">
        <button
          onClick={isConnected ? () => setIsMobilePostModalOpen(true) : openConnectModal}
          className="w-14 h-14 bg-yellow-500 hover:bg-yellow-400 text-black rounded-full shadow-lg hover:shadow-xl transition-all duration-200 flex items-center justify-center"
        >
          {isConnected ? (
            <HiOutlinePlus className="w-6 h-6" />
          ) : (
            <BsWallet className="w-6 h-6" />
          )}
        </button>
      </div>

      {/* Mobile Post Modal */}
      <MobilePostModal 
        isOpen={isMobilePostModalOpen}
        onClose={() => setIsMobilePostModalOpen(false)}
      />
    </MainLayout>
  )
}

export default BookmarksPage

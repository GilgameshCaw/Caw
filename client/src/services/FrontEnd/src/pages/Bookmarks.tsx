import React, { useState } from 'react'
import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { HiOutlineSearch } from 'react-icons/hi'
import FeedItem from '~/components/FeedItem'
import type { CawItem } from '~/types'
import MobilePostModal from '~/components/MobilePostModal'
import { useAccount } from "wagmi"
import { useConnectModal } from "@rainbow-me/rainbowkit"
import { HiOutlinePlus } from "react-icons/hi"
import { BsWallet } from 'react-icons/bs'

const BookmarksPage: React.FC = () => {
  const { isDark } = useTheme()
  const [searchQuery, setSearchQuery] = useState('')
  const [isMobilePostModalOpen, setIsMobilePostModalOpen] = useState(false)
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()

  // Mock bookmarked posts data - using CawItem format
  const bookmarkedPosts: CawItem[] = [
    {
      id: 'bookmark-1',
      user: { tokenId: 1, username: 'cawuser1' },
      content: 'Just discovered the amazing potential of decentralized social media! The future is here and it\'s built on blockchain technology. #CawProtocol #Web3',
      timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      likeCount: 24,
      hasLiked: true,
      hasRecawed: false,
      commentCount: 8,
      recawCount: 12,
      cawonce: 1,
      userId: 1,
      originalCaw: undefined
    },
    {
      id: 'bookmark-2',
      user: { tokenId: 2, username: 'blockchaindev' },
      content: 'Building the next generation of social platforms with Caw Protocol. The community-driven approach is revolutionary!',
      timestamp: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      likeCount: 156,
      hasLiked: false,
      hasRecawed: false,
      commentCount: 23,
      recawCount: 45,
      cawonce: 2,
      userId: 2,
      originalCaw: undefined
    },
    {
      id: 'bookmark-3',
      user: { tokenId: 3, username: 'cryptoenthusiast' },
      content: 'The staking rewards on Caw Protocol are incredible! Earning while participating in the ecosystem. This is how social media should work.',
      timestamp: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      likeCount: 89,
      hasLiked: true,
      hasRecawed: false,
      commentCount: 15,
      recawCount: 28,
      cawonce: 3,
      userId: 3,
      originalCaw: undefined
    },
    {
      id: 'bookmark-4',
      user: { tokenId: 4, username: 'web3builder' },
      content: 'Just minted my first CawName! The process was so smooth and the community is incredibly supportive. Ready to be part of the revolution!',
      timestamp: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
      likeCount: 67,
      hasLiked: false,
      hasRecawed: false,
      commentCount: 12,
      recawCount: 19,
      cawonce: 4,
      userId: 4,
      originalCaw: undefined
    },
    {
      id: 'bookmark-5',
      user: { tokenId: 5, username: 'decentralized' },
      content: 'The beauty of Caw Protocol lies in its simplicity. No complex interfaces, just pure social interaction powered by blockchain technology.',
      timestamp: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
      likeCount: 203,
      hasLiked: true,
      hasRecawed: false,
      commentCount: 34,
      recawCount: 67,
      cawonce: 5,
      userId: 5,
      originalCaw: undefined
    },
    {
      id: 'bookmark-6',
      user: { tokenId: 6, username: 'cawcommunity' },
      content: 'Welcome to all new members joining our growing community! Together we\'re building the future of social media. #Cawmmunity',
      timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      likeCount: 445,
      hasLiked: true,
      hasRecawed: false,
      commentCount: 78,
      recawCount: 123,
      cawonce: 6,
      userId: 6,
      originalCaw: undefined
    }
  ]

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
        <div className="space-y-0">
          {bookmarkedPosts.map((post) => (
            <FeedItem key={post.id} item={post} />
          ))}
        </div>

        {/* Empty State (if no bookmarks) */}
        {bookmarkedPosts.length === 0 && (
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
              Save posts you want to read later by clicking the bookmark icon
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

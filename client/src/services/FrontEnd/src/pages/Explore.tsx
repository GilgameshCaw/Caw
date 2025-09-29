import React, { useState, useEffect } from 'react'
import MainLayout from '~/layouts/MainLayout'
import { Tabs, TabItem } from '~/components/Tabs'
import { useTheme } from '~/hooks/useTheme'
import Feed from '~/components/Feed'
import TrendingHashtags from '~/components/TrendingHashtags'
import CommunityStats from '~/components/CommunityStats'
import DiscussionHashtags from '~/components/DiscussionHashtags'
import LatestUpdates from '~/components/LatestUpdates'
import MobilePostModal from '~/components/MobilePostModal'
import MobileSubMenu from '~/components/MobileSubMenu'
import MobileBottomNavbar from '~/components/MobileBottomNavbar'
import { useAccount } from "wagmi"
import { useConnectModal } from "@rainbow-me/rainbowkit"
import { HiOutlinePlus } from "react-icons/hi"
import { BsWallet } from 'react-icons/bs'

type ExploreTab = 'For you' | 'Discover' | 'Updates' | 'Community'

const ExplorePage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<ExploreTab>('For you')
  const [searchQuery, setSearchQuery] = useState('')
  const [isMobilePostModalOpen, setIsMobilePostModalOpen] = useState(false)
  const [isSubMenuOpen, setIsSubMenuOpen] = useState(false)
  const [activeBottomTab, setActiveBottomTab] = useState('search')
  const [isScrolling, setIsScrolling] = useState(false)
  const { isDark } = useTheme()
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()

  // Handle scroll detection for transparency effect
  useEffect(() => {
    let scrollTimer: NodeJS.Timeout

    const handleScroll = () => {
      setIsScrolling(true)
      clearTimeout(scrollTimer)
      scrollTimer = setTimeout(() => {
        setIsScrolling(false)
      }, 150)
    }

    window.addEventListener('scroll', handleScroll)
    return () => {
      window.removeEventListener('scroll', handleScroll)
      clearTimeout(scrollTimer)
    }
  }, [])

  // Mobile tabs - all 4 tabs with horizontal scroll
  const mobileTabs: TabItem<ExploreTab>[] = [
    { id: 'For you', label: 'For you' },
    { id: 'Discover', label: 'Discover' },
    { id: 'Updates', label: 'Updates' },
    { id: 'Community', label: 'Community' },
  ]

  // Desktop tabs - all 4 tabs
  const desktopTabs: TabItem<ExploreTab>[] = [
    { id: 'For you', label: 'For you' },
    { id: 'Discover', label: 'Discover' },
    { id: 'Updates', label: 'Updates' },
    { id: 'Community', label: 'Community' },
  ]

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4 bg-black flex flex-col">
        {/* Header */}
        <div className="mb-6 flex-shrink-0">
          <h1 className={`text-2xl font-bold transition-colors duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            Explore
          </h1>
        </div>

        {/* Search Bar */}
        <div className="mb-6 flex-shrink-0">
          <div className="relative">
            <input
              type="text"
              placeholder="Search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={`w-full pl-10 pr-4 py-3 rounded-full border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-gray-500/30 ${
                isDark 
                  ? 'bg-black border-gray-600 text-white placeholder-gray-400 focus:bg-transparent' 
                  : 'bg-white border-gray-300 text-black placeholder-gray-500 focus:bg-transparent'
              }`}
            />
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="mb-6 flex-shrink-0">
          <div className="flex justify-center space-x-6 border-b border-white/10">
            {/* Mobile tabs - all 4 tabs with horizontal scroll */}
            <div className="flex overflow-x-auto scrollbar-hide space-x-4 sm:hidden pb-2 -mb-2">
              {mobileTabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`py-2 px-4 text-sm font-medium transition-all duration-200 cursor-pointer whitespace-nowrap flex-shrink-0 ${
                    activeTab === tab.id
                      ? isDark
                        ? 'text-white border-b-2 border-white'
                        : 'text-black border-b-2 border-black'
                      : isDark
                        ? 'text-gray-400 hover:text-white hover:bg-white/5'
                        : 'text-gray-600 hover:text-black hover:bg-gray-100'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            
            {/* Desktop tabs - all 4 tabs */}
            {desktopTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`py-2 px-4 sm:px-8 text-sm font-medium transition-all duration-200 cursor-pointer hidden sm:block ${
                  activeTab === tab.id
                    ? isDark
                      ? 'text-white border-b-2 border-white'
                      : 'text-black border-b-2 border-black'
                    : isDark
                      ? 'text-gray-400 hover:text-white hover:bg-white/5'
                      : 'text-gray-600 hover:text-black hover:bg-gray-100'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto custom-scrollbar-alt">
          {activeTab === 'For you' && (
            <div className="space-y-4">
              <h2 className={`text-lg font-semibold transition-colors duration-300 ${
                isDark ? 'text-white' : 'text-black'
              }`}>
                Recommended for you
              </h2>
              <Feed filter="For you" />
            </div>
          )}

          {activeTab === 'Discover' && (
            <div className="space-y-6">
              <div className="space-y-4">
                <h2 className={`text-lg font-semibold transition-colors duration-300 ${
                  isDark ? 'text-white' : 'text-black'
                }`}>
                  What's trending
                </h2>
                <TrendingHashtags />
              </div>

              <div className={`border-t transition-colors duration-300 ${
                isDark ? 'border-white/20' : 'border-gray-200'
              }`}></div>

              <div className="space-y-4">
                <h2 className={`text-lg font-semibold transition-colors duration-300 ${
                  isDark ? 'text-white' : 'text-black'
                }`}>
                  Discover more
                </h2>
                <Feed filter="For you" />
              </div>
            </div>
          )}

          {activeTab === 'Updates' && (
            <div className="space-y-6">
              <div className="space-y-4">
                <h2 className={`text-lg font-semibold transition-colors duration-300 ${
                  isDark ? 'text-white' : 'text-black'
                }`}>
                  Latest updates
                </h2>
                <LatestUpdates />
              </div>
            </div>
          )}

          {activeTab === 'Community' && (
            <div className="space-y-6">
              {/* Community Stats */}
              <div className="space-y-4">
                <h2 className={`text-lg font-semibold transition-colors duration-300 ${
                  isDark ? 'text-white' : 'text-black'
                }`}>
                  Community overview
                </h2>
                <CommunityStats />
              </div>

              <div className={`border-t transition-colors duration-300 ${
                isDark ? 'border-white/20' : 'border-gray-200'
              }`}></div>

              {/* Community Highlights */}
              <div className="space-y-4">
                <h2 className={`text-lg font-semibold transition-colors duration-300 ${
                  isDark ? 'text-white' : 'text-black'
                }`}>
                  Community highlights
                </h2>
                <Feed filter="For you" />
              </div>

              <div className={`border-t transition-colors duration-300 ${
                isDark ? 'border-white/20' : 'border-gray-200'
              }`}></div>

              {/* Discussion Topics */}
              <div className="space-y-4">
                <h2 className={`text-lg font-semibold transition-colors duration-300 text-left ${
                  isDark ? 'text-white' : 'text-black'
                }`}>
                  Discussion topics
                </h2>
                <DiscussionHashtags />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Floating Action Button - Mobile only */}
      <div className="md:hidden fixed bottom-20 right-12 z-30 transform-none">
        <button
          onClick={isConnected ? () => setIsSubMenuOpen(true) : openConnectModal}
          className={`w-14 h-14 bg-yellow-500 hover:bg-yellow-400 text-black rounded-full shadow-lg hover:shadow-xl transition-all duration-200 flex items-center justify-center ${
            isScrolling ? 'opacity-60' : 'opacity-100'
          }`}
        >
          {isConnected ? (
            <HiOutlinePlus className="w-6 h-6" />
          ) : (
            <BsWallet className="w-6 h-6" />
          )}
        </button>
      </div>

      {/* Mobile Submenu */}
      <MobileSubMenu
        isOpen={isSubMenuOpen}
        onClose={() => setIsSubMenuOpen(false)}
        onPostClick={() => setIsMobilePostModalOpen(true)}
        onVoiceRoomClick={() => {
          // Voice Room functionality placeholder
        }}
      />

      {/* Mobile Post Modal */}
      <MobilePostModal 
        isOpen={isMobilePostModalOpen}
        onClose={() => setIsMobilePostModalOpen(false)}
      />

      {/* Mobile Bottom Navbar */}
      <MobileBottomNavbar 
        activeTab={activeBottomTab}
        onTabChange={(tab) => setActiveBottomTab(tab)}
        isVisible={!isMobilePostModalOpen}
      />
    </MainLayout>
  )
}

export default ExplorePage

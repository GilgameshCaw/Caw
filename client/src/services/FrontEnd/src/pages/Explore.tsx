import React, { useState, useEffect } from 'react'
import MainLayout from '~/layouts/MainLayout'
import { Tabs, TabItem } from '~/components/Tabs'
import { useTheme } from '~/hooks/useTheme'
import Feed from '~/components/Feed'
import TrendingHashtags from '~/components/TrendingHashtags'
import CommunityStats from '~/components/CommunityStats'
import DiscussionHashtags from '~/components/DiscussionHashtags'
import SearchBar from '~/components/SearchBar'
import { useSearchParams } from 'react-router-dom'

type ExploreTab = 'foryou' | 'discover' | 'updates' | 'community'

const TAB_LABELS: Record<ExploreTab, string> = {
  'foryou': 'For you',
  'discover': 'Discover',
  'updates': 'Updates',
  'community': 'Community'
}

const VALID_TABS: ExploreTab[] = ['foryou', 'discover', 'updates', 'community']

const ExplorePage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab') as ExploreTab | null
  const [activeTab, setActiveTab] = useState<ExploreTab>(
    tabParam && VALID_TABS.includes(tabParam) ? tabParam : 'foryou'
  )

  // Sync URL when tab changes
  useEffect(() => {
    const currentTab = searchParams.get('tab')
    if (currentTab !== activeTab) {
      if (activeTab === 'foryou') {
        searchParams.delete('tab')
      } else {
        searchParams.set('tab', activeTab)
      }
      setSearchParams(searchParams, { replace: true })
    }
  }, [activeTab])
  const { isDark } = useTheme()

  // Mobile tabs - only For You and Community
  const mobileTabs: TabItem<ExploreTab>[] = [
    { id: 'foryou', label: TAB_LABELS['foryou'] },
    { id: 'community', label: TAB_LABELS['community'] },
  ]

  // Desktop tabs - all 4 tabs
  const desktopTabs: TabItem<ExploreTab>[] = [
    { id: 'foryou', label: TAB_LABELS['foryou'] },
    { id: 'discover', label: TAB_LABELS['discover'] },
    { id: 'updates', label: TAB_LABELS['updates'] },
    { id: 'community', label: TAB_LABELS['community'] },
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
          <SearchBar />
        </div>

        {/* Tabs */}
        <div className="mb-6 flex-shrink-0">
          {/* Mobile tabs - only For You and Community */}
          <div className="md:hidden">
            <Tabs<ExploreTab>
              tabs={mobileTabs}
              active={activeTab}
              onChange={setActiveTab}
            />
          </div>

          {/* Desktop tabs - all 4 tabs */}
          <div className="hidden md:block">
            <Tabs<ExploreTab>
              tabs={desktopTabs}
              active={activeTab}
              onChange={setActiveTab}
            />
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto custom-scrollbar-alt">
          {activeTab === 'foryou' && (
            <div>
              <Feed filter="For you" title={
                <h2 className={`text-lg font-semibold mb-4 transition-colors duration-300 ${
                  isDark ? 'text-white' : 'text-black'
                }`}>
                  Recommended for you
                </h2>
              } />
            </div>
          )}

          {activeTab === 'discover' && (
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

              <div>
                <Feed filter="For you" title={
                  <h2 className={`text-lg font-semibold mb-4 transition-colors duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    Discover more
                  </h2>
                } />
              </div>
            </div>
          )}

          {activeTab === 'updates' && (
            <div className="space-y-6">
              <div className="space-y-4">
                <h2 className={`text-lg font-semibold transition-colors duration-300 ${
                  isDark ? 'text-white' : 'text-black'
                }`}>
                  Latest posts
                </h2>
                <Feed filter="latest" />
              </div>
            </div>
          )}

          {activeTab === 'community' && (
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

              {/* Discussion Topics */}
              <div className="space-y-4">
                <h2 className={`text-lg font-semibold transition-colors duration-300 ${
                  isDark ? 'text-white' : 'text-black'
                }`}>
                  Discussion topics
                </h2>
                <DiscussionHashtags />
              </div>

              <div className={`border-t transition-colors duration-300 ${
                isDark ? 'border-white/20' : 'border-gray-200'
              }`}></div>

              {/* Community Highlights */}
              <div>
                <Feed filter="For you" title={
                  <h2 className={`text-lg font-semibold mb-4 transition-colors duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    Community highlights
                  </h2>
                } />
              </div>
            </div>
          )}
        </div>
      </div>
    </MainLayout>
  )
}

export default ExplorePage

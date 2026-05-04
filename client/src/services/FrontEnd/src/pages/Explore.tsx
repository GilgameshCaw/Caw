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
import { useT } from '~/i18n/I18nProvider'

type ExploreTab = 'foryou' | 'discover' | 'updates' | 'community'

// TAB_LABELS removed — derived inside the component so labels reflect the
// active locale.

const VALID_TABS: ExploreTab[] = ['foryou', 'discover', 'updates', 'community']

const ExplorePage: React.FC = () => {
  const t = useT()
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
    { id: 'foryou', label: t('feed.tab.for_you') },
    { id: 'community', label: t('explore.tab.community') },
  ]

  // Desktop tabs - all 4 tabs
  const desktopTabs: TabItem<ExploreTab>[] = [
    { id: 'foryou', label: t('feed.tab.for_you') },
    { id: 'discover', label: t('explore.tab.discover') },
    { id: 'updates', label: t('explore.tab.updates') },
    { id: 'community', label: t('explore.tab.community') },
  ]

  return (
    <MainLayout>
      <div className={`max-w-2xl mx-auto px-6 py-4 flex flex-col ${isDark ? 'bg-black' : 'bg-white'}`}>
        {/* Header */}
        <div className="mb-6 flex-shrink-0">
          <h1 className={`text-2xl font-bold transition-colors duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            {t('explore.title')}
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
                  {t('explore.recommended')}
                </h2>
              } />
            </div>
          )}

          {activeTab === 'discover' && (
            <div className="space-y-6">
              <div className="space-y-4">
                <TrendingHashtags
                  title={
                    <h2 className={`text-lg font-semibold transition-colors duration-300 ${
                      isDark ? 'text-white' : 'text-black'
                    }`}>
                      What's trending
                    </h2>
                  }
                />
              </div>

              <div className={`border-t transition-colors duration-300 ${
                isDark ? 'border-white/20' : 'border-gray-200'
              }`}></div>

              <div>
                <Feed filter="For you" title={
                  <h2 className={`text-lg font-semibold mb-4 transition-colors duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    {t('explore.discover_more')}
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
                  {t('explore.latest')}
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
                  {t('explore.community_overview')}
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
                  {t('explore.discussion_topics')}
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
                    {t('explore.highlights')}
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

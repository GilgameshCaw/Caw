import { Tabs, TabItem } from '~/components/Tabs'
import MainLayout from "~/layouts/MainLayout";
import PostForm from "~/components/PostForm";
import Feed, { type FeedRef } from "~/components/Feed";
import React, { useState, useRef, useEffect } from "react";
import { useTheme } from '~/hooks/useTheme';
import { useSearchParams } from 'react-router-dom';
import { useTokenDataStore } from '~/store/tokenDataStore';
import { useUserByUsername } from '~/hooks/useUserData';

type MainTab = 'following' | 'foryou'

const TAB_LABELS: Record<MainTab, string> = {
  'following': 'Following',
  'foryou': 'For You'
}

const TAB_TO_FILTER: Record<MainTab, 'Following' | 'For you'> = {
  'following': 'Following',
  'foryou': 'For you'
}

export const Main: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab') as MainTab | null
  const activeToken = useTokenDataStore(s => {
    const tokens = Object.values(s.tokensByAddress).flat()
    return tokens.find(t => t.tokenId === s.activeTokenId) || tokens[0]
  })
  const [defaultResolved, setDefaultResolved] = useState(!!tabParam)
  const [activeTab, setActiveTab] = useState<MainTab>(
    tabParam && (tabParam === 'following' || tabParam === 'foryou') ? tabParam : 'following'
  )

  // If no explicit tab param, check following count and default to 'foryou' if 0
  const { data: userData } = useUserByUsername(
    !tabParam && !defaultResolved ? activeToken?.username : undefined
  )
  useEffect(() => {
    if (tabParam || defaultResolved || !userData) return
    if (userData.followingCount === 0) {
      setActiveTab('foryou')
    }
    setDefaultResolved(true)
  }, [tabParam, defaultResolved, userData])

  // Sync URL when tab changes
  useEffect(() => {
    const currentTab = searchParams.get('tab')
    if (currentTab !== activeTab) {
      if (activeTab === 'following') {
        // Remove tab param for default tab
        searchParams.delete('tab')
      } else {
        searchParams.set('tab', activeTab)
      }
      setSearchParams(searchParams, { replace: true })
    }
  }, [activeTab])
  const { isDark } = useTheme()
  const feedRef = useRef<FeedRef>(null)

  const mainTabs: TabItem<MainTab>[] = [
    { id: 'following', label: TAB_LABELS['following'] },
    { id: 'foryou', label: TAB_LABELS['foryou'] },
  ]

  return (
    <MainLayout>
      <div className="max-w-2xl md:max-w-none lg:max-w-2xl mx-auto px-3 sm:px-6 py-4">
        <Tabs<MainTab>
          tabs={mainTabs}
          active={activeTab}
          onChange={setActiveTab}
        />
        {/* PostForm - Always visible */}
        <div className="border-b border-white/20">
          <PostForm onSuccess={() => feedRef.current?.refresh()}/>
        </div>
        <div className="w-full">
          <Feed
            ref={feedRef}
            filter={TAB_TO_FILTER[activeTab]}
          />
        </div>
      </div>

    </MainLayout>
  );
};
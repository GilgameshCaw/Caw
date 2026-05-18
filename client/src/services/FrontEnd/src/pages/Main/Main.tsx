import { Tabs, TabItem } from '~/components/Tabs'
import PostForm from "~/components/PostForm";
import Feed, { type FeedRef } from "~/components/Feed";
import React, { useState, useRef, useEffect } from "react";
import { useTheme } from '~/hooks/useTheme';
import { useSearchParams } from 'react-router-dom';
import { useTokenDataStore } from '~/store/tokenDataStore';
import { useUserByUsername } from '~/hooks/useUserData';
import { useT } from '~/i18n/I18nProvider';

type MainTab = 'following' | 'foryou'

// TAB_LABELS now derived inside the component so they reflect the
// active locale. TAB_TO_FILTER stays static — its values are lookup
// keys consumed by Feed's prop, never rendered to users.

const TAB_TO_FILTER: Record<MainTab, 'Following' | 'For you'> = {
  'following': 'Following',
  'foryou': 'For you'
}

export const Main: React.FC = () => {
  const t = useT()
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

  // Horizontal swipe on the feed body toggles between Following / For You,
  // matching X's mobile gesture. Vertical scroll wins on commit (lock axis
  // after the first 10px of movement) so reading isn't hijacked.
  const swipeRef = useRef<{ x: number; y: number; locked: 'h' | 'v' | null } | null>(null)
  const onFeedTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return
    swipeRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, locked: null }
  }
  const onFeedTouchMove = (e: React.TouchEvent) => {
    const s = swipeRef.current
    if (!s || s.locked === 'v') return
    const dx = e.touches[0].clientX - s.x
    const dy = e.touches[0].clientY - s.y
    if (s.locked === null) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
      s.locked = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'
    }
  }
  const onFeedTouchEnd = (e: React.TouchEvent) => {
    const s = swipeRef.current
    swipeRef.current = null
    if (!s || s.locked !== 'h') return
    const dx = e.changedTouches[0].clientX - s.x
    if (Math.abs(dx) < 60) return
    if (dx < 0 && activeTab === 'following') setActiveTab('foryou')
    else if (dx > 0 && activeTab === 'foryou') setActiveTab('following')
  }

  const mainTabs: TabItem<MainTab>[] = [
    { id: 'following', label: t('feed.tab.following') },
    { id: 'foryou', label: t('feed.tab.for_you') },
  ]

  return (
    <div className="max-w-2xl md:max-w-none lg:max-w-2xl mx-auto px-3 sm:px-6 py-4">
      <Tabs<MainTab>
        tabs={mainTabs}
        active={activeTab}
        onChange={setActiveTab}
      />
      {/* PostForm - Always visible */}
      <div className={`border-b ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
        <PostForm onSuccess={() => feedRef.current?.refresh()} composeMode trackDraft autoFocus={false}/>
      </div>
      <div
        className="w-full"
        onTouchStart={onFeedTouchStart}
        onTouchMove={onFeedTouchMove}
        onTouchEnd={onFeedTouchEnd}
        onTouchCancel={() => { swipeRef.current = null }}
      >
        <Feed
          ref={feedRef}
          filter={TAB_TO_FILTER[activeTab]}
        />
      </div>
    </div>
  );
};
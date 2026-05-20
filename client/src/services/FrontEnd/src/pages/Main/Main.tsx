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

// Tab-change slide: render the active tab with a brief
// translateX-from-the-side + fade-in transition so the user
// perceives the switch (bug #299 — nir noted the instant swap felt
// "cheap" / too fast to notice). Single-tab-mounted approach (rather
// than two-Feeds-side-by-side) avoids the document-scroll coupling
// that would let a vertical scroll on one tab also scroll the other.
const SLIDE_MS = 240
// Direction of the slide depends on which tab the user moved towards.
// Moving rightwards (following → foryou) → new content slides in from
// the right; moving leftwards → from the left. Mirrors X's behaviour.

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

  // Track the direction of the most-recent tab change so we can slide
  // the new content in from the correct side. -1 = slid in from the
  // left (came from a rightward neighbour), +1 = from the right.
  const [slideFrom, setSlideFrom] = useState<-1 | 0 | 1>(0)
  const prevTabRef = useRef(activeTab)
  useEffect(() => {
    const prev = prevTabRef.current
    if (prev === activeTab) return
    // following → foryou is a leftward swipe by the user, so the new
    // content slides in from the right (+1). foryou → following is the
    // opposite.
    setSlideFrom(prev === 'following' && activeTab === 'foryou' ? 1
      : prev === 'foryou' && activeTab === 'following' ? -1
      : 0)
    prevTabRef.current = activeTab
    // Reset slideFrom back to 0 after the animation lands so subsequent
    // re-renders (caused by data loading, etc.) don't replay it.
    const id = window.setTimeout(() => setSlideFrom(0), SLIDE_MS + 50)
    return () => window.clearTimeout(id)
  }, [activeTab])

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

  // The slide-in transform. Using a CSS-keyframed approach via the
  // `key` prop on the wrapper: changing the key remounts the wrapper
  // and the CSS transition runs from its initial off-screen position
  // to translate(0). Slide distance is 24px — small enough that it's
  // not a full screen-width swipe, but visible enough to convey the
  // tab change.
  const initialTranslate = slideFrom === 1 ? '24px' : slideFrom === -1 ? '-24px' : '0px'

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
        className="w-full overflow-x-hidden"
        onTouchStart={onFeedTouchStart}
        onTouchMove={onFeedTouchMove}
        onTouchEnd={onFeedTouchEnd}
        onTouchCancel={() => { swipeRef.current = null }}
      >
        {/* key={activeTab} forces a fresh mount per tab so the CSS
            slide-in animation replays. The animation runs once via
            the keyframe applied as inline style — no JS frame loop. */}
        <div
          key={activeTab}
          style={{
            animation: slideFrom !== 0
              ? `caw-tab-slide-in ${SLIDE_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1) both`
              : undefined,
            // Custom property consumed by the keyframe. Inline so
            // each side-direction renders without needing a CSS file
            // change.
            ['--caw-tab-slide-from' as any]: initialTranslate,
          }}
        >
          <Feed
            ref={feedRef}
            filter={TAB_TO_FILTER[activeTab]}
          />
        </div>
      </div>
    </div>
  );
};

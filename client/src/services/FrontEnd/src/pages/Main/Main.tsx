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

  // NOTE: feed-body swipe-to-switch-tabs was removed intentionally. Horizontally
  // swipeable children (e.g. the suggested-users carousel) bubbled their swipe up
  // to this handler and switched For You / Following unexpectedly. Tabs now change
  // ONLY on a direct click of the Tabs control (onChange below).

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
      {/* Full-bleed divider like feed rows, without changing inner gutter. */}
      <div className={`-mx-3 sm:-mx-6 border-b ${isDark ? 'border-white/20' : 'border-gray-300'}`}>
        <div className="px-3 sm:px-6">
          <Tabs<MainTab>
            tabs={mainTabs}
            active={activeTab}
            onChange={setActiveTab}
            showDivider={false}
          />
        </div>
      </div>
      {/* PostForm - Always visible */}
      {/* Keep the composer divider consistent with FeedItem full-bleed rows
          (FeedItem uses -mx-* to reach the column edges). */}
      <div className={`-mx-3 sm:-mx-6 px-3 sm:px-6 border-b ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
        <PostForm onSuccess={() => feedRef.current?.refresh()} composeMode trackDraft autoFocus={false} />
      </div>
      {/* NOTE: overflow-x-visible so FeedItem can use negative margins for
          full-bleed hover up to the column edges (X-style). */}
      <div className="w-full overflow-x-visible">
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

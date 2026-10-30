/**
 * Feed.hiddenParent.test.tsx
 *
 * Home and profile feeds collapse items that share an underlying caw: the
 * first occurrence wins. A plain recaw of a hidden parent renders nothing, so
 * it must not be that first occurrence, or an older quote of the same parent
 * disappears with it.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// ─── Mock external dependencies ──────────────────────────────────────────────

let feedItems: object[] = []

vi.mock('../api/client', () => ({
  apiFetch: vi.fn(async () => ({ items: feedItems })),
  IndexingError: class extends Error {},
  RemovedCawError: class extends Error {},
}))

// FeedItem itself is covered by FeedItem.hiddenParent.test.tsx; here only
// which items reach it matters.
vi.mock('./FeedItem', () => ({
  default: ({ item }: { item: { id: string } }) => <div data-testid="feed-item">{item.id}</div>,
}))

vi.mock('./SuggestedUsers', () => ({ default: () => null }))
vi.mock('./Skeleton', () => ({ LoadingSpinner: () => null }))
vi.mock('~/hooks/useViewTracking', () => ({ useViewTracking: () => {} }))
vi.mock('~/hooks/useHostVerification', () => ({ useHostVerification: () => {} }))
vi.mock('~/hooks/useTxQueueMonitor', () => ({
  setFeedRefreshCallback: () => {},
  setFeedItemUpdateCallback: () => {},
  setFeedRefreshVisibleCallback: () => {},
}))
vi.mock('~/hooks/useMutePreferences', () => ({
  useMutePreferences: () => ({ preferences: {} }),
  shouldFilterPost: () => false,
}))
vi.mock('~/hooks/useUserData', () => ({ useUserByUsername: () => ({ data: undefined }) }))
vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: true }) }))
vi.mock('~/i18n/I18nProvider', () => ({ useT: () => (key: string) => key }))

// ─── Import component after mocks ─────────────────────────────────────────────

import Feed from './Feed'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const counts = {
  likeCount: 0, viewCount: 0, hasLiked: false, hasRecawed: false, hasReplied: false, hasTipped: false,
  tipCount: 0, totalTipAmount: 0, commentCount: 0, recawCount: 0, hashtags: [],
}

function parent(status: 'SUCCESS' | 'HIDDEN') {
  return {
    ...counts, id: '100', content: status === 'HIDDEN' ? '' : 'the parent body', timestamp: '2026-10-01T00:00:00Z',
    user: { id: 1, tokenId: 1, username: 'alice' }, cawonce: 5, status,
  }
}

/** Newest first, as the API returns them: bob's plain recaw, then his older quote. */
function recawThenQuote(status: 'SUCCESS' | 'HIDDEN') {
  const user = { id: 2, tokenId: 2, username: 'bob' }
  return [
    { ...counts, id: '300', action: 'RECAW', content: '', timestamp: '2026-10-03T00:00:00Z', user, cawonce: 11, status: 'SUCCESS', parent: parent(status) },
    { ...counts, id: '200', action: 'RECAW', content: 'my take', isQuote: true, timestamp: '2026-10-02T00:00:00Z', user, cawonce: 10, status: 'SUCCESS', parent: parent(status) },
  ]
}

/** Feed caches items per filter + username at module level, so each test
 *  uses its own username. */
async function renderedIds(filter: string, username: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter><Feed filter={filter} username={username} /></MemoryRouter>
    </QueryClientProvider>,
  )
  await waitFor(() => expect(screen.queryAllByTestId('feed-item').length).toBeGreaterThan(0))
  return screen.getAllByTestId('feed-item').map(el => el.textContent)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Feed with a plain recaw of a HIDDEN parent', () => {
  beforeEach(() => { feedItems = [] })

  it('keeps the older quote on a profile feed', async () => {
    feedItems = recawThenQuote('HIDDEN')
    expect(await renderedIds('profile', 'u1')).toEqual(['200'])
  })

  it('keeps the older quote on the home feed', async () => {
    feedItems = recawThenQuote('HIDDEN')
    expect(await renderedIds('For you', 'u2')).toEqual(['200'])
  })

  it('control: with a visible parent, the newer plain recaw wins as before', async () => {
    feedItems = recawThenQuote('SUCCESS')
    expect(await renderedIds('profile', 'u3')).toEqual(['300'])
  })
})

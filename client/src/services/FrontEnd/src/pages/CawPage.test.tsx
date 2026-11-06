import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const s = vi.hoisted(() => ({ replies: [] as any[], onSuccess: null as null | (() => void), urls: [] as string[] }))

// Pages the replies the way GET /api/caws/:id does: oldest first, the cursor row
// excluded, 20 at a time.
vi.mock('~/api/client', () => {
  class RemovedCawError extends Error { author: string | null = null }
  return {
    RemovedCawError,
    apiFetch: vi.fn(async (url: string) => {
      s.urls.push(url)
      const cursor = new URL(url, 'http://x').searchParams.get('commentCursor')
      const start = cursor ? s.replies.findIndex(r => String(r.id) === cursor) + 1 : 0
      const page = s.replies.slice(start, start + 20)
      const hasMore = s.replies.length > start + 20
      return {
        caw: { id: 1, content: 'root', status: 'SUCCESS', action: 'CAW', timestamp: '2026-01-01T00:00:00Z', user: { tokenId: 9, username: 'alice' }, commentCount: s.replies.length },
        comments: page,
        recaws: [],
        tips: [],
        hasMoreComments: hasMore,
        nextCommentCursor: hasMore ? page[page.length - 1].id : undefined,
      }
    }),
  }
})
vi.mock('~/components/FeedItem', () => ({
  default: ({ item, isReply }: any) => (isReply ? <div data-testid="row">{`${item.id}${item.content === 'edited' ? ' edited' : ''}`}</div> : <div data-testid="main">{String(item.id)}</div>),
}))
vi.mock('~/components/PostForm', () => ({
  default: ({ onSuccess }: any) => {
    s.onSuccess = onSuccess
    return null
  },
}))
vi.mock('~/components/modals/SignInModal', () => ({ default: () => null }))
vi.mock('~/components/Avatar', () => ({ UserAvatar: () => null }))
vi.mock('~/hooks/useViewTracking', () => ({ useViewTrackingSingle: () => {} }))
vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: true }) }))
vi.mock('~/i18n/I18nProvider', () => ({ useT: () => (k: string) => k }))
vi.mock('~/store/tokenDataStore', () => ({
  useTokenDataStore: (sel: any) => sel({ activeTokenId: 7 }),
  useActiveToken: () => ({ tokenId: 7, username: 'bob' }),
  usePriceStore: (sel: any) => sel({ priceMap: {} }),
}))

import { CawPage } from './CawPage'

const reply = (i: number) => ({
  id: 100 + i,
  content: `r${i}`,
  status: 'SUCCESS',
  action: 'CAW',
  timestamp: new Date(1767225600000 + i * 1000).toISOString(),
  cawonce: i,
  user: { tokenId: 8, username: 'carol' },
  parent: { id: 1 },
})
const repliesUpTo = (n: number) => Array.from({ length: n }, (_, i) => reply(i + 1))
const rows = () => screen.queryAllByTestId('row').map(e => e.textContent!)
const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => String(100 + from + i))
const loadMore = () => screen.queryByText('caw_page.load_more_replies')

async function mount(expectedRows: number) {
  render(
    <MemoryRouter initialEntries={['/users/alice/caw/1-root']}>
      <Routes>
        <Route path="/users/:username/caw/:idSlug" element={<CawPage />} />
      </Routes>
    </MemoryRouter>,
  )
  await waitFor(() => expect(rows()).toHaveLength(expectedRows))
}
async function clickLoadMore(expectedRows: number) {
  fireEvent.click(loadMore()!)
  await waitFor(() => expect(rows()).toHaveLength(expectedRows))
}
function sendReply(i: number) {
  s.replies.push(reply(i))
  s.onSuccess!()
}

describe('CawPage replies after posting one', () => {
  beforeEach(() => {
    s.replies = []
    s.onSuccess = null
    s.urls = []
  })
  afterEach(() => cleanup())

  it('adds the reply when everything fits on the first page', async () => {
    s.replies = repliesUpTo(5)
    await mount(5)
    sendReply(6)
    await waitFor(() => expect(rows()).toEqual(ids(1, 6)))
    expect(loadMore()).toBeNull()
  })

  it('offers Load more when the new reply is the first one past the first page', async () => {
    s.replies = repliesUpTo(20)
    await mount(20)
    expect(loadMore()).toBeNull()
    sendReply(21)
    await waitFor(() => expect(loadMore()).not.toBeNull())
    await clickLoadMore(21)
    expect(rows()).toEqual(ids(1, 21))
  })

  it('keeps later pages and shows the reply when every page was loaded', async () => {
    s.replies = repliesUpTo(25)
    await mount(20)
    await clickLoadMore(25)
    expect(loadMore()).toBeNull()
    sendReply(26)
    await waitFor(() => expect(rows()).toEqual(ids(1, 26)))
    expect(loadMore()).toBeNull()
  })

  it('keeps later pages and skips nothing when more pages remain', async () => {
    s.replies = repliesUpTo(50)
    await mount(20)
    await clickLoadMore(40)
    sendReply(51)
    await waitFor(() => expect(s.urls.filter(u => !u.includes('commentCursor'))).toHaveLength(2))
    expect(rows()).toEqual(ids(1, 40))
    await clickLoadMore(51)
    expect(rows()).toEqual(ids(1, 51))
    expect(loadMore()).toBeNull()
  })

  it('updates a row the first page brings back, with later pages loaded', async () => {
    s.replies = repliesUpTo(25)
    await mount(20)
    await clickLoadMore(25)
    s.replies[0] = { ...s.replies[0], content: 'edited' }
    sendReply(26)
    await waitFor(() => expect(rows()).toHaveLength(26))
    expect(rows()[0]).toBe('101 edited')
  })
})

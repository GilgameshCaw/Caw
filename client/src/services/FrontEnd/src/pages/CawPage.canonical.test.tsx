/**
 * CawPage.canonical.test.tsx
 *
 * The canonical-URL effect in CawPage must leave an already-canonical URL
 * alone, also under a locale prefix (/ja/users/...), and fix a stale slug
 * with a single replace.
 *
 * Browsers hand back a structured clone from history.state, so after every
 * replace React Router builds location.state as a new object. The spy below
 * does the same clone, so a page that keeps replacing the URL keeps running
 * its effect, as it does in Chrome. After 50 replaces the spy stops passing
 * calls through: history.state then stays the same object, the effect stops
 * re-running, and the test fails on the count instead of hanging. (Throwing
 * from the spy instead would break React's state for the tests after it.)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import React from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('~/i18n/I18nProvider', () => ({
  useT: () => (key: string) => key,
}))
vi.mock('~/components/PostForm', () => ({ default: () => null }))
vi.mock('~/components/FeedItem', () => ({ default: () => null }))
vi.mock('~/components/Avatar', () => ({ UserAvatar: () => null }))
vi.mock('~/components/modals/SignInModal', () => ({ default: () => null }))
vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: true }) }))
vi.mock('~/hooks/useViewTracking', () => ({ useViewTrackingSingle: () => {} }))
vi.mock('~/store/tokenDataStore', () => ({
  useTokenDataStore: (sel: (s: { activeTokenId: undefined }) => unknown) => sel({ activeTokenId: undefined }),
  useActiveToken: () => undefined,
  usePriceStore: (sel: (s: { priceMap: Record<string, number> }) => unknown) => sel({ priceMap: {} }),
}))
vi.mock('~/store/pendingPostsStore', () => ({
  usePendingPostsStore: (sel: (s: { pendingPosts: unknown[] }) => unknown) => sel({ pendingPosts: [] }),
}))
vi.mock('~/api/client', () => ({
  apiFetch: vi.fn(),
  RemovedCawError: class RemovedCawError extends Error {
    author: string | null = null
  },
}))

import { apiFetch } from '~/api/client'
import { CawPage } from './CawPage'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CAW = {
  id: 7,
  content: 'Hello world',
  status: 'SUCCESS',
  action: 'CAW',
  timestamp: '2026-11-01T00:00:00.000Z',
  user: { username: 'alice', tokenId: 1 },
  likeCount: 0,
  recawCount: 0,
  commentCount: 0,
  tipCount: 0,
}
const CANONICAL = '/users/alice/caw/7-hello-world'

const realReplace = window.history.replaceState.bind(window.history)
let replaced: string[] = []
let spy: ReturnType<typeof vi.spyOn>

/** Put the window on `path` with `usr` as the router state, then render. */
async function open(path: string, usr: unknown) {
  realReplace({ usr, key: 'seed', idx: 0 }, '', path)
  spy = vi.spyOn(window.history, 'replaceState').mockImplementation(
    (state: unknown, unused: string, url?: string | URL | null) => {
      replaced.push(String(url))
      if (replaced.length > 50) return
      realReplace(structuredClone(state), unused, url)
    },
  )
  render(
    <BrowserRouter>
      <Routes>
        <Route path="/users/:username/caw/:idSlug" element={<CawPage />} />
        <Route path="/:locale/users/:username/caw/:idSlug" element={<CawPage />} />
      </Routes>
    </BrowserRouter>,
  )
  // Let the /api/caws/:id response land and the effects settle.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 50))
  })
}

beforeEach(() => {
  replaced = []
  vi.mocked(apiFetch).mockImplementation(async () => ({ caw: { ...CAW }, comments: [] }))
})

afterEach(() => {
  cleanup()
  spy?.mockRestore()
  vi.mocked(apiFetch).mockReset()
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CawPage canonical URL', () => {
  it('leaves a canonical /ja/ URL alone when opened from the feed (state set)', async () => {
    await open(`/ja${CANONICAL}`, { caw: CAW })
    expect(replaced).toEqual([])
    expect(window.location.pathname).toBe(`/ja${CANONICAL}`)
  })

  it('leaves a canonical /ja/ URL alone when opened directly (no state)', async () => {
    await open(`/ja${CANONICAL}`, null)
    expect(replaced).toEqual([])
    expect(window.location.pathname).toBe(`/ja${CANONICAL}`)
  })

  it('fixes a stale slug under /ja/ with one replace and keeps the prefix', async () => {
    await open('/ja/users/alice/caw/7-old-slug', { caw: CAW })
    expect(replaced).toEqual([`/ja${CANONICAL}`])
    expect(window.location.pathname).toBe(`/ja${CANONICAL}`)
  })

  it('leaves a canonical bare URL alone', async () => {
    await open(CANONICAL, { caw: CAW })
    expect(replaced).toEqual([])
    expect(window.location.pathname).toBe(CANONICAL)
  })

  it('fixes a stale slug on a bare URL with one replace', async () => {
    await open('/users/alice/caw/7-old-slug', { caw: CAW })
    expect(replaced).toEqual([CANONICAL])
    expect(window.location.pathname).toBe(CANONICAL)
  })

  it('still sends /en/ to the bare path', async () => {
    await open(`/en${CANONICAL}`, null)
    expect(replaced).toEqual([CANONICAL])
    expect(window.location.pathname).toBe(CANONICAL)
  })
})

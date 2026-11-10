/**
 * Notifications.poll.test.tsx
 *
 * The notifications page polls /api/notifications/unread-count every 30 s.
 * These tests cover when that poll runs: not while the tab is hidden, and
 * once right away when the tab becomes visible again.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'

// ─── Mock external dependencies ──────────────────────────────────────────────

const apiFetch = vi.fn()
let serverUnread = 0

vi.mock('~/api/client', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}))

vi.mock('~/utils/localizedRouter', () => ({
  useNavigate: () => () => {},
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))

vi.mock('~/hooks/useTheme', () => ({
  useTheme: () => ({ isDark: true }),
}))

vi.mock('~/i18n/I18nProvider', () => ({
  useT: () => (key: string) => key,
}))

const ACTIVE_TOKEN = { tokenId: 7, username: 'tester' }

vi.mock('~/store/tokenDataStore', () => ({
  useActiveToken: () => ACTIVE_TOKEN,
  usePriceStore: (selector: (s: { priceMap: Record<string, number> }) => unknown) =>
    selector({ priceMap: {} }),
}))

vi.mock('~/store/marketplaceStore', () => ({
  useMarketplaceStore: { getState: () => ({ openViewOffers: () => {} }) },
}))

vi.mock('~/store/verifyWalletStore', () => ({
  useVerifyWalletStore: { getState: () => ({ show: () => {} }) },
}))

vi.mock('~/store/modalStore', () => ({
  useModalStore: (selector: (s: { openModal: () => void }) => unknown) =>
    selector({ openModal: () => {} }),
}))

vi.mock('~/api/actions', () => ({
  useSignAndSubmitAction: () => async () => ({}),
  decompressSignedText: (text: string) => text,
}))

vi.mock('~/components/UserHoverCard', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('~/components/Avatar', () => ({ default: () => null }))
vi.mock('~/components/PollMiniResults', () => ({ default: () => null }))

// ─── Helpers ─────────────────────────────────────────────────────────────────

const UNREAD_COUNT_URL = '/api/notifications/unread-count'
const LIST_URL = '/api/notifications?'

const callsTo = (prefix: string) =>
  apiFetch.mock.calls.filter(([url]) => String(url).startsWith(prefix)).length

const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
}

const changeVisibility = async (hidden: boolean) => {
  setHidden(hidden)
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
  })
}

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

// The component keeps a module-level cache of the last list, so each test
// loads a fresh copy of the module.
const renderPage = async () => {
  vi.resetModules()
  const { default: Notifications } = await import('./Notifications')
  const view = render(<Notifications />)
  await advance(0)
  return view
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Notifications unread-count poll', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    serverUnread = 0
    apiFetch.mockReset()
    apiFetch.mockImplementation(async (url: string) => {
      if (url.startsWith(UNREAD_COUNT_URL)) return { unreadCount: serverUnread }
      if (url.startsWith(LIST_URL)) return { notifications: [], unreadCount: 0, hasMore: false }
      return {}
    })
    setHidden(false)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    setHidden(false)
  })

  it('polls every 30 s while the tab is visible', async () => {
    await renderPage()
    expect(callsTo(UNREAD_COUNT_URL)).toBe(0)

    await advance(30_000)
    expect(callsTo(UNREAD_COUNT_URL)).toBe(1)

    await advance(30_000)
    expect(callsTo(UNREAD_COUNT_URL)).toBe(2)
  })

  it('does not poll while the tab is hidden', async () => {
    await renderPage()
    await changeVisibility(true)

    await advance(5 * 60_000)
    expect(callsTo(UNREAD_COUNT_URL)).toBe(0)
  })

  it('checks once right away when the tab becomes visible, then keeps polling', async () => {
    await renderPage()
    await changeVisibility(true)
    await advance(5 * 60_000)

    await changeVisibility(false)
    expect(callsTo(UNREAD_COUNT_URL)).toBe(1)

    await advance(30_000)
    expect(callsTo(UNREAD_COUNT_URL)).toBe(2)
  })

  it('reloads the list when the check on becoming visible finds new notifications', async () => {
    await renderPage()
    const listCallsAfterLoad = callsTo(LIST_URL)

    await changeVisibility(true)
    serverUnread = 1
    await advance(5 * 60_000)
    expect(callsTo(LIST_URL)).toBe(listCallsAfterLoad)

    await changeVisibility(false)
    expect(callsTo(LIST_URL)).toBe(listCallsAfterLoad + 1)
  })

  it('stops listening for visibility changes after unmount', async () => {
    const view = await renderPage()
    view.unmount()

    await changeVisibility(true)
    await changeVisibility(false)
    await advance(60_000)
    expect(callsTo(UNREAD_COUNT_URL)).toBe(0)
  })
})

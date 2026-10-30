/**
 * FeedItem.hiddenParent.test.tsx
 *
 * A plain recaw renders its parent as the post itself. When the parent has
 * been hidden (by its author or a moderator), the recaw must render nothing —
 * replies and quotes already show a "removed" placeholder instead of the
 * parent's body.
 */

import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// ─── Mock external dependencies ──────────────────────────────────────────────

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useChainId: () => 1,
}))

vi.mock('~/api/actions', () => ({
  CLIENT_ID: 1,
  useSignAndSubmitAction: () => ({ signAndSubmitAction: vi.fn() }),
  getValidatorTip: vi.fn(() => 0),
  getTipTiers: vi.fn(async () => []),
}))

vi.mock('~/api/client', () => ({ apiFetch: vi.fn(async () => ({})) }))

vi.mock('~/hooks/useConnectModalBridge', () => ({
  useConnectModalBridge: () => ({ openConnectModal: vi.fn() }),
}))

vi.mock('~/hooks/useWalletPopulation', () => ({ useWalletPopulation: () => ({ population: 'none' }) }))
vi.mock('~/hooks/useViewerLanguage', () => ({ useViewerLanguage: () => 'en' }))
vi.mock('~/hooks/useMyRole', () => ({ useMyRole: () => ({ isModerator: false, isAdmin: false }) }))
vi.mock('~/hooks/useHasActiveSession', () => ({ useHasActiveSession: () => false }))

vi.mock('~/hooks/useUserData', async (orig) => ({
  ...(await orig<object>()),
  useUserByToken: () => ({ data: undefined }),
  useUserByUsername: () => ({ data: undefined }),
}))

vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: true }) }))
vi.mock('~/utils/translate', () => ({ translateTextDetailed: vi.fn(), detectScript: () => 'latin' }))
vi.mock('~/i18n/I18nProvider', () => ({ useT: () => (key: string) => key }))
vi.mock('./modals/TipModal', () => ({ default: () => null }))
vi.mock('~/config/chains', () => ({ chains: {} }))

// ─── Import component after mocks ─────────────────────────────────────────────

import FeedItem from './FeedItem'
import type { CawItem } from '~/types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BODY = 'the parent body'
const counts = {
  likeCount: 0, viewCount: 0, hasLiked: false, hasRecawed: false, hasReplied: false, hasTipped: false,
  tipCount: 0, totalTipAmount: 0, commentCount: 0, recawCount: 0, hashtags: [],
}

/** status HIDDEN with the body still attached is what a node without the
 *  server-side fix sends; with it, the body arrives empty. */
function parent(status: 'SUCCESS' | 'HIDDEN', content = BODY) {
  return {
    ...counts, id: '100', content, timestamp: new Date().toISOString(),
    user: { id: 1, tokenId: 1, username: 'alice' }, cawonce: 5, status,
  }
}

function child(over: object) {
  return {
    ...counts, id: '200', timestamp: new Date().toISOString(),
    user: { id: 2, tokenId: 2, username: 'bob' }, cawonce: 9, status: 'SUCCESS',
    ...over,
  }
}

function renderItem(item: object) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter><FeedItem item={item as CawItem} /></MemoryRouter>
    </QueryClientProvider>,
  )
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FeedItem with a HIDDEN parent', () => {
  it('renders nothing for a plain recaw whose parent is hidden', () => {
    const { container } = renderItem(child({ action: 'RECAW', content: '', parent: parent('HIDDEN') }))
    expect(container.textContent).toBe('')
  })

  it('renders nothing for it either when the server already dropped the body', () => {
    const { container } = renderItem(child({ action: 'RECAW', content: '', parent: parent('HIDDEN', '') }))
    expect(container.textContent).toBe('')
  })

  it('shows a reply, without the hidden parent body', () => {
    const { container } = renderItem(child({ action: 'CAW', content: 'my reply', parent: parent('HIDDEN') }))
    expect(container.textContent).toContain('my reply')
    expect(container.textContent).toContain('post.replying_to_removed')
    expect(container.textContent).not.toContain(BODY)
  })

  it('shows a quote, without the hidden parent body', () => {
    const { container } = renderItem(child({ action: 'RECAW', content: 'my take', isQuote: true, parent: parent('HIDDEN') }))
    expect(container.textContent).toContain('my take')
    expect(container.textContent).not.toContain(BODY)
  })

  it('control: a plain recaw of a visible parent shows the parent body', () => {
    const { container } = renderItem(child({ action: 'RECAW', content: '', parent: parent('SUCCESS') }))
    expect(container.textContent).toContain(BODY)
  })
})

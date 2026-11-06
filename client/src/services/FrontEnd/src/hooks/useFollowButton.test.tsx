import React, { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'

const s = vi.hoisted(() => ({
  sign: vi.fn(async (_action: { actionType: string }) => ({ txQueueId: 77 })),
  api: vi.fn(async (url: string, _opts?: unknown) =>
    url.includes('follow-status') ? { isFollowing: false, isPending: true } : { ok: true },
  ),
}))

vi.mock('~/api/actions', () => ({ useSignAndSubmitAction: () => s.sign }))
vi.mock('~/api/client', () => ({ apiFetch: s.api }))
vi.mock('wagmi', () => ({ useAccount: () => ({ address: '0xabc', isConnected: true }) }))
vi.mock('~/hooks/useHasActiveSession', () => ({ useHasActiveSession: () => true }))
vi.mock('~/hooks/useWalletPopulation', () => ({ useWalletPopulation: () => ({ population: 'A' }) }))
vi.mock('~/i18n/I18nProvider', () => ({ useT: () => (k: string) => k }))
vi.mock('~/store/tokenDataStore', () => ({
  useActiveToken: () => ({ tokenId: 7, address: '0xabc', username: 'bob' }),
  useTokenDataStore: (sel: (state: { activeTokenId: number }) => unknown) => sel({ activeTokenId: 7 }),
}))

import { useFollowButton } from './useFollowButton'

// Feeds the optimistic value back into the prop, as Profile and FollowListModal do.
function ParentThatTracksState({ start }: { start: boolean }) {
  const [following, setFollowing] = useState(start)
  const f = useFollowButton({ targetUserId: 66, initialIsFollowing: following, onFollowStateChange: setFollowing })
  return <button data-testid="b" onClick={f.handleFollowClick}>{String(f.isFollowing)}</button>
}

// Leaves the prop alone, as UserCard does.
function ParentWithFixedProp({ start }: { start: boolean }) {
  const f = useFollowButton({ targetUserId: 66, initialIsFollowing: start })
  return <button data-testid="b" onClick={f.handleFollowClick}>{String(f.isFollowing)}</button>
}

const label = () => screen.getByTestId('b').textContent
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)) })
async function clickAndWaitForSign() {
  fireEvent.click(screen.getByTestId('b'))
  await waitFor(() => expect(s.sign).toHaveBeenCalled())
  await settle()
}

describe('useFollowButton cancel', () => {
  afterEach(() => {
    cleanup()
    s.sign.mockClear()
    s.api.mockClear()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  for (const [name, Parent] of [
    ['a parent that tracks state', ParentThatTracksState],
    ['a parent with a fixed prop', ParentWithFixedProp],
  ] as const) {
    for (const start of [false, true]) {
      it(`goes back to ${start} and sends the same action next, with ${name}`, async () => {
        render(<Parent start={start} />)
        await clickAndWaitForSign()
        const first = s.sign.mock.calls[0][0].actionType
        expect(first).toBe(start ? 'unfollow' : 'follow')
        expect(label()).toBe(String(!start))

        fireEvent.click(screen.getByTestId('b'))
        await settle()
        expect(s.api.mock.calls.some(c => c[0].includes('/cancel'))).toBe(true)
        expect(label()).toBe(String(start))

        s.sign.mockClear()
        await clickAndWaitForSign()
        expect(s.sign.mock.calls[0][0].actionType).toBe(first)
      })
    }
  }

  it('goes back to the state before the click when polling times out', async () => {
    const now = vi.spyOn(Date, 'now')
    const t0 = 1_700_000_000_000
    now.mockReturnValue(t0)
    render(<ParentThatTracksState start={false} />)
    await clickAndWaitForSign()
    expect(label()).toBe('true')

    // The first poll runs 1.5s after polling starts and records the start time.
    await act(async () => { await new Promise(r => setTimeout(r, 1600)) })
    now.mockReturnValue(t0 + 5 * 60 * 1000 + 1)
    await act(async () => { await new Promise(r => setTimeout(r, 2100)) })
    expect(label()).toBe('false')
  })
})

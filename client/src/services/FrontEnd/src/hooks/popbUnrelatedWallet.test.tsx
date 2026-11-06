// A passkey (Pop-B) user with an unrelated wallet connected and no Quick Sign session.
// Real QuickSignRenewModal, useEnsureWallet, useFollowButton and TipModal. Population A is the control.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, renderHook, act, cleanup } from '@testing-library/react'

const s = vi.hoisted(() => ({
  OWNER: '0x1111111111111111111111111111111111111111', STRAY: '0x2222222222222222222222222222222222222222',
  account: { address: undefined as string | undefined, isConnected: false },
  population: 'B' as 'A' | 'B' | 'none',
  openConnect: vi.fn(), createSession: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useAccount: () => s.account, useChainId: () => 1,
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }), useWalletClient: () => ({ data: undefined }),
}))
vi.mock('~/hooks/useConnectModalBridge', () => ({ useConnectModalBridge: () => ({ openConnectModal: s.openConnect }) }))
vi.mock('@rainbow-me/rainbowkit', () => ({ useConnectModal: () => ({ openConnectModal: s.openConnect }) }))
vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: false }) }))
vi.mock('~/i18n/I18nProvider', () => ({ useT: () => (k: string) => k }))
vi.mock('~/store/sessionKeyStore', () => {
  const f: any = (sel: any) => sel({ setEnabled: vi.fn() }); return { useSessionKeyStore: f, useHasActiveSession: () => false }
})
vi.mock('~/store/tokenDataStore', () => {
  const tok = { tokenId: 1, username: 'alice', address: s.OWNER, owner: s.OWNER, stakedAmount: 10n ** 30n }
  const f: any = (sel: any) => sel({ activeTokenId: 1, priceMap: {} })
  return { useActiveToken: () => tok, useTokenDataStore: f, usePriceStore: (sel: any) => sel({ priceMap: { 'a-hunters-dream': 1 } }) }
})
vi.mock('~/hooks/useSessionKey', () => ({
  useCreateSession: () => s.createSession, getDefaultSpendLimit: () => 1n, getDefaultTipCeiling: () => 1n,
  useNetworkTipTargetAsCAW: () => ({ tipCeilingCaw: 1n, tipCeilingFallbackCaw: 1n }), DEFAULT_SESSION_DURATION: 1,
  useHasActiveSession: () => false,
}))
vi.mock('~/api/actions', () => ({
  getTipTiers: () => ({ fast: 1n }), useSignAndSubmitAction: () => vi.fn(), getValidatorTip: () => 1n,
}))
vi.mock('~/components/QuickSignOptions', () => ({ default: () => null }))
vi.mock('~/components/modals/QuickSignModal', () => ({ useQuickSignPromptStore: { setState: vi.fn() } }))
vi.mock('~/components/Tooltip', () => ({ default: ({ children }: any) => <>{children}</> }))
vi.mock('~/components/modals/ModalWrapper', () => ({ default: ({ children, isOpen }: any) => (isOpen ? <div>{children}</div> : null) }))
vi.mock('~/hooks/useWalletPopulation', () => ({ useWalletPopulation: () => ({ population: s.population, address: s.OWNER, loading: false }) }))
vi.mock('~/hooks/useHasActiveSession', () => ({ useHasActiveSession: () => false }))
vi.mock('~/store/pendingSpendStore', () => { const f: any = () => ({}); f.getState = () => ({}); return { usePendingSpendStore: f } })
vi.mock('~/store/balanceChangeStore', () => { const f: any = () => ({}); f.getState = () => ({}); return { useBalanceChangeStore: f } })
vi.mock('~/api/client', () => ({ apiFetch: vi.fn(async () => ({})) }))
vi.mock('~/components/modals/InsufficientStakeModal', () => ({ default: () => null }))
vi.mock('~/components/modals/ModalHeader', () => ({ default: () => null }))
vi.mock('~/utils/errorMessage', () => ({ formatWalletError: (e: any) => String(e) }))

import QuickSignRenewModal, { useQuickSignRenewStore } from '~/components/modals/QuickSignRenewModal'
import { useFollowButton } from '~/hooks/useFollowButton'
import TipModal from '~/components/modals/TipModal'

const open = (retryManual: any) => act(() => { useQuickSignRenewStore.getState().show('spend_limit', vi.fn(), vi.fn(), retryManual) })
const button = (text: string) => screen.getByText(text) as HTMLButtonElement
const follow = () => renderHook(() => useFollowButton({ targetUserId: 5, initialIsFollowing: false } as any)).result.current.wrongWallet

beforeEach(() => { cleanup(); s.openConnect.mockClear(); s.population = 'B' })
afterEach(() => { cleanup(); act(() => { useQuickSignRenewStore.setState({ isOpen: false }) }) })

describe('QuickSignRenewModal', () => {
  it('Pop-B with an unrelated wallet can use both buttons', () => {
    s.account = { address: s.STRAY, isConnected: true }
    render(<QuickSignRenewModal />); open(vi.fn())
    expect(button('quick_sign.btn.sign_manually').disabled).toBe(false)
    expect(button('quick_sign_renew.btn.reenable').disabled).toBe(false)
  })

  it('Pop-A with the wrong wallet still can not', () => {
    s.population = 'A'; s.account = { address: s.STRAY, isConnected: true }
    render(<QuickSignRenewModal />); open(vi.fn())
    expect(button('quick_sign.btn.sign_manually').disabled).toBe(true)
    expect(button('quick_sign_renew.btn.reenable').disabled).toBe(true)
  })

  it('Pop-B with no wallet signs manually without being sent to connect', async () => {
    s.account = { address: undefined, isConnected: false }
    const retry = vi.fn()
    render(<QuickSignRenewModal />); open(retry)
    fireEvent.click(button('quick_sign.btn.sign_manually'))
    await new Promise(r => setTimeout(r, 200))
    expect(s.openConnect).not.toHaveBeenCalled()
    expect(retry).toHaveBeenCalledTimes(1)
    expect(useQuickSignRenewStore.getState().isOpen).toBe(false)
  })

  it('Pop-A with no wallet is still asked to connect first', async () => {
    s.population = 'A'; s.account = { address: undefined, isConnected: false }
    const retry = vi.fn()
    render(<QuickSignRenewModal />); open(retry)
    fireEvent.click(button('quick_sign.btn.sign_manually'))
    await new Promise(r => setTimeout(r, 200))
    expect(s.openConnect).toHaveBeenCalledTimes(1)
    expect(retry).not.toHaveBeenCalled()
  })
})

describe('useFollowButton.wrongWallet', () => {
  it('is false for Pop-B with an unrelated wallet', () => {
    s.account = { address: s.STRAY, isConnected: true }
    expect(follow()).toBe(false)
  })
  it('is true for Pop-A with the wrong wallet, false with the right one', () => {
    s.population = 'A'; s.account = { address: s.STRAY, isConnected: true }
    expect(follow()).toBe(true)
    s.account = { address: s.OWNER, isConnected: true }
    expect(follow()).toBe(false)
  })
})

describe('TipModal', () => {
  const submit = () => (screen.getAllByRole('button') as HTMLButtonElement[]).find(b => b.className.includes('py-2.5'))!
  const show = () => render(<TipModal isOpen onClose={() => {}} recipientTokenId={5} recipientUsername="bob" />)
  it('does not disable the submit button for Pop-B with an unrelated wallet', () => {
    s.account = { address: s.STRAY, isConnected: true }
    show()
    expect(submit().disabled).toBe(false)
  })
  it('disables it for Pop-A with the wrong wallet', () => {
    s.population = 'A'; s.account = { address: s.STRAY, isConnected: true }
    show()
    expect(submit().disabled).toBe(true)
  })
})

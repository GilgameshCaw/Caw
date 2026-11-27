import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ProfileLookupAction from '~/components/ProfileLookupAction'
import { WalletProfileLookupContext } from '~/config/walletProfileLookup'
import useTokenDataUpdate from '~/hooks/useTokenDataUpdate'
import { useTokenDataStore } from '~/store/tokenDataStore'
import SignInModal from './SignInModal'

const profile = vi.hoisted(() => ({
  owner: '0x0000000000000000000000000000000000000001',
  connected: true,
  tokensQuery: vi.fn(),
  l1: {} as { data?: unknown[]; isFetching?: boolean; isError?: boolean; isSuccess?: boolean },
  otherWalletL1: undefined as undefined | { data: unknown[]; isSuccess: boolean },
  l2: {} as { data?: unknown[]; isFetching?: boolean; isError?: boolean; isSuccess?: boolean },
  readL1: vi.fn(),
  readL2: vi.fn(),
  readBatch: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: profile.connected, address: profile.connected ? profile.owner : undefined }),
  useReadContract: ({ functionName, args, query }: {
    functionName: string; args?: unknown[]; query?: { enabled?: boolean }
  }) => {
    if (functionName !== 'tokens') return { ...profile.l2, refetch: profile.readL2 }
    profile.tokensQuery(args?.[0], query?.enabled)
    return { ...(args?.[0] === profile.owner ? profile.l1 : profile.otherWalletL1), refetch: profile.readL1 }
  },
  useReadContracts: () => ({ refetch: profile.readBatch }),
}))
vi.mock('~/hooks/useSessionKey', () => ({ clearSessionIfOnChainDead: vi.fn() }))
vi.mock('~/hooks/useEnsureWallet', () => ({ useEnsureWallet: () => vi.fn() }))
vi.mock('~/api/client', () => ({ apiFetch: vi.fn() }))
vi.mock('~/i18n/I18nProvider', () => ({ useT: () => (key: string) => key }))
vi.mock('~/utils/localizedRouter', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}))
vi.mock('./ModalWrapper', () => ({
  default: ({ children, isOpen }: { children: ReactNode; isOpen: boolean }) => isOpen ? <>{children}</> : null,
}))

function WithLookup({ children }: { children: ReactNode }) {
  const lookup = useTokenDataUpdate()
  return (
    <WalletProfileLookupContext.Provider value={lookup}>
      {children}
    </WalletProfileLookupContext.Provider>
  )
}

function SignInWithLookup() {
  return <WithLookup><SignInModal isOpen /></WithLookup>
}

function LookupActionWithLookup() {
  return (
    <WithLookup>
      <ProfileLookupAction className="" createLabel="Create profile" />
      <SignInModal />
    </WithLookup>
  )
}

const owned = () => [{
  tokenId: 17, username: 'existing', owner: profile.owner, ownerBalance: 0n, withdrawable: 0n,
}]
const createLink = () => screen.queryByRole('link', { name: 'signin_modal.create_profile' })
const retry = () => screen.getByRole('button', { name: 'profile_lookup.retry' })

beforeEach(() => {
  profile.connected = true
  profile.l1 = {}
  profile.l2 = {}
  profile.otherWalletL1 = undefined
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Live network disabled') }))
  useTokenDataStore.setState({
    tokensByAddress: {}, lastAddress: profile.owner, hasHydrated: true,
    activeTokenId: undefined, activeTokenIdByAddress: {},
  })
})

it('offers sign-in when there is no address and checks once a wallet connects', () => {
  profile.connected = false
  useTokenDataStore.setState({ lastAddress: undefined })
  const view = render(<LookupActionWithLookup />)

  expect(profile.tokensQuery).toHaveBeenCalled()
  expect(profile.tokensQuery.mock.calls.every(([owner, enabled]) => owner === undefined && enabled === false)).toBe(true)
  expect(screen.queryByRole('status')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'common.sign_in' }))
  expect(screen.getByRole('button', { name: 'signin_modal.sign_in_passkey' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'signin_modal.sign_in_wallet' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
  expect(screen.queryByRole('link', { name: 'Create profile' })).toBeNull()
  expect(profile.readL1).not.toHaveBeenCalled()

  profile.connected = true
  profile.l1 = { isFetching: true }
  view.rerender(<LookupActionWithLookup />)
  expect(profile.tokensQuery).toHaveBeenCalledWith(profile.owner, true)
  expect(screen.getByRole('status')).toHaveTextContent('profile_lookup.checking')
  expect(screen.queryByRole('button', { name: 'common.sign_in' })).toBeNull()
})

afterEach(() => {
  cleanup()
  expect(fetch).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

it('keeps creation hidden while the wallet lookup has no result', () => {
  profile.l1 = { isFetching: true }
  render(<SignInWithLookup />)
  expect(screen.getByRole('status').textContent).toBe('profile_lookup.checking')
  expect(createLink()).toBeNull()
})

it('offers a read retry instead of minting after a failed lookup, even with an old empty result', () => {
  profile.l1 = { data: [], isError: true }
  render(<SignInWithLookup />)
  expect(createLink()).toBeNull()
  expect(screen.queryByText('signin_modal.default_message')).toBeNull()
  fireEvent.click(retry())
  expect(profile.readL1).toHaveBeenCalledOnce()
  expect(profile.readL2).not.toHaveBeenCalled()
})

it('shows creation only after a successful empty lookup finishes', () => {
  const empty: unknown[] = []
  profile.l1 = { data: empty, isFetching: true, isSuccess: true }
  const view = render(<SignInWithLookup />)
  expect(createLink()).toBeNull()
  profile.l1 = { data: empty, isSuccess: true }
  view.rerender(<SignInWithLookup />)
  expect(createLink()?.getAttribute('href')).toBe('/usernames/new')
})

it('does not offer creation when an existing profile is waiting for its L2 data', () => {
  profile.l1 = { data: owned(), isSuccess: true }
  profile.l2 = { isError: true }
  const view = render(<SignInWithLookup />)
  expect(createLink()).toBeNull()
  fireEvent.click(retry())
  expect(profile.readL1).toHaveBeenCalledOnce()
  expect(profile.readL2).toHaveBeenCalledOnce()
  profile.l2 = { data: [], isSuccess: true }
  view.rerender(<SignInWithLookup />)
  expect(screen.getByRole('button', { name: 'common.continue' })).toBeTruthy()
  expect(createLink()).toBeNull()
})

it('uses the connected wallet lookup rather than a cached profile viewed under a different owner', () => {
  useTokenDataStore.setState({ lastAddress: '0x0000000000000000000000000000000000000002' })
  profile.otherWalletL1 = { data: [], isSuccess: true }
  profile.l1 = { isError: true }
  render(<SignInWithLookup />)
  expect(retry()).toBeTruthy()
  expect(createLink()).toBeNull()
})

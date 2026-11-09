// Profile: "user" is a real on-chain name, a slow response for the previous
// profile must not replace the current one, and the viewer's own offer is
// shown in token units, not base units.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import type { ReactNode } from 'react'

type Json = Record<string, unknown>

// Child components aren't under test. Hoisted so the vi.mock factories can use them.
const c = vi.hoisted(() => ({
  Null: () => null,
  Pass: ({ children }: { children?: ReactNode }) => children ?? null,
}))

const s = vi.hoisted(() => ({
  VIEWER: '0x1111111111111111111111111111111111111111',
  params: {} as { username?: string },
  activeToken: undefined as { tokenId: number; username: string } | undefined,
  offers: [] as Json[],
  // Per-username responses; a name missing here answers like a 404.
  users: {} as Record<string, () => Promise<Json>>,
  apiFetch: vi.fn<(url: string) => Promise<unknown>>(),
}))

vi.mock('react-router-dom', () => ({
  useParams: () => s.params,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}))
vi.mock('~/utils/localizedRouter', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}))
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: true, address: s.VIEWER }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
  useChainId: () => 2,
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, isPending: false, error: null, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false }),
  useReadContract: () => ({ data: undefined, isLoading: false }),
}))
vi.mock('~/api/client', () => ({
  apiFetch: s.apiFetch,
  retryOnIndexing: (fn: () => Promise<unknown>) => fn(),
}))
vi.mock('~/api/actions', () => ({ useSignAndSubmitAction: () => vi.fn() }))
vi.mock('~/config/chains', () => ({ chains: { l1: { chainId: 1 }, l2: { chainId: 2 } } }))
vi.mock('~/i18n/I18nProvider', () => ({ useT: () => (k: string) => k }))
vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: false }) }))
vi.mock('~/hooks/useEnsureWallet', () => ({
  useEnsureWallet: () => async (_opts: unknown, cb: () => Promise<void>) => { await cb() },
}))
vi.mock('~/hooks/useWalletPopulation', () => ({ useWalletPopulation: () => ({ population: 'A' }) }))
vi.mock('~/hooks/useConnectModalBridge', () => ({ useConnectModalBridge: () => ({ openConnectModal: vi.fn() }) }))
vi.mock('~/hooks/useDmIdentity', () => ({ useDmIdentity: () => ({ hasIdentity: false }) }))
vi.mock('~/hooks/useDm', () => ({ useDmClient: () => ({ initializeClient: vi.fn(), isLoading: false }) }))
vi.mock('~/hooks/useFollowButton', () => ({
  useFollowButton: () => ({
    isFollowing: false, isPending: false, isSigning: false, wrongWallet: false,
    handleFollowClick: vi.fn(), buttonText: 'Follow', hoverText: 'Follow',
  }),
}))
vi.mock('~/utils/errorMessage', () => ({ formatWalletError: (e: unknown) => String(e) }))
vi.mock('~/utils/defaultAvatar', () => ({ getUserAvatar: () => '', getDefaultAvatarForUser: () => '' }))
vi.mock('~/store/tokenDataStore', () => ({
  useActiveToken: () => s.activeToken,
  useTokenDataStore: (sel: (st: Json) => unknown) =>
    sel({ activeTokenId: s.activeToken?.tokenId ?? null, setAvatar: vi.fn(), avatarsByTokenId: {} }),
}))
vi.mock('~/store/modalStore', () => ({ useModalStore: () => ({ openModal: vi.fn() }) }))
vi.mock('~/store/signInModalStore', () => ({ useSignInModalStore: (sel: (st: Json) => unknown) => sel({ show: vi.fn() }) }))
vi.mock('~/store/authStore', () => ({ useAuthStore: (sel: (st: Json) => unknown) => sel({ authorizedTokenIds: [] }) }))
vi.mock('~/store/blockedUsersStore', () => ({
  useBlockedUsersStore: () => ({ blockUser: vi.fn(), unblockUser: vi.fn(), isBlocked: () => false }),
}))
vi.mock('~/store/transferModalStore', () => ({
  useTransferModalStore: Object.assign(() => ({}), { getState: () => ({ show: vi.fn() }) }),
}))
vi.mock('~/store/marketplaceStore', () => ({
  useMarketplaceStore: Object.assign(() => ({}), { getState: () => ({}) }),
}))
vi.mock('~/components/Avatar', () => ({ default: c.Null }))
vi.mock('~/components/Tabs', () => ({ Tabs: c.Null }))
vi.mock('~/components/Feed', () => ({ default: c.Null }))
vi.mock('~/components/CopyAddressButton', () => ({ default: c.Null }))
vi.mock('~/components/XBadge', () => ({ default: c.Null }))
vi.mock('~/components/Tooltip', () => ({ default: c.Pass }))
vi.mock('~/components/ProfileEditForm', () => ({ default: c.Null }))
vi.mock('~/components/ImageLightbox', () => ({ default: c.Null }))
vi.mock('~/components/modals/InsufficientStakeModal', () => ({ default: c.Null }))
vi.mock('~/components/modals/AvatarCropperModal', () => ({ default: c.Null }))
vi.mock('~/components/modals/TipModal', () => ({ default: c.Null }))
vi.mock('~/components/modals/ShareProfileCardModal', () => ({ ShareProfileCardModal: c.Null }))

import { Profile } from './Profile'

function user(tokenId: number, username: string, displayName: string): Json {
  return {
    id: tokenId, address: '0x2222222222222222222222222222222222222222', tokenId, username, displayName,
    cawCount: 0, followerCount: 0, followingCount: 0, likeCount: 0, replyCount: 0, mediaCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

const userFetches = () => s.apiFetch.mock.calls.map(c => c[0]).filter(u => /^\/api\/users\/[^/]+$/.test(u))

beforeEach(() => {
  cleanup()
  s.params = {}
  s.activeToken = undefined
  s.offers = []
  s.users = {}
  s.apiFetch.mockReset()
  s.apiFetch.mockImplementation(async (url: string) => {
    const m = url.match(/^\/api\/users\/([^/]+)$/)
    if (m) {
      const answer = s.users[m[1]]
      if (!answer) throw new Error('API error: 404')
      return answer()
    }
    if (url.startsWith('/api/marketplace/listings/token/')) return null
    if (url.startsWith('/api/marketplace/offers/token/')) return { offers: s.offers, total: s.offers.length }
    if (url.startsWith('/api/notifications/is-account-muted/')) return { isMuted: false }
    return {}
  })
})

describe('Profile: the name "user"', () => {
  it('loads /users/user like any other name', async () => {
    s.users.user = async () => user(42, 'user', 'Owner Of User')
    s.params = { username: 'user' }
    render(<Profile />)
    await waitFor(() => expect(screen.getAllByText('Owner Of User').length).toBeGreaterThan(0))
    expect(userFetches()).toEqual(['/api/users/user'])
  })

  it('loads /profile when the active account is named "user"', async () => {
    s.users.user = async () => user(42, 'user', 'Owner Of User')
    s.activeToken = { tokenId: 42, username: 'user' }
    render(<Profile />)
    await waitFor(() => expect(screen.getAllByText('Owner Of User').length).toBeGreaterThan(0))
    expect(userFetches()).toEqual(['/api/users/user'])
  })

  it('fetches nothing on /profile with no active account', async () => {
    render(<Profile />)
    await new Promise(r => setTimeout(r, 50))
    expect(userFetches()).toEqual([])
  })
})

describe('Profile: moving between profiles', () => {
  it('keeps the current profile when the previous one answers late', async () => {
    const alice = deferred<Json>()
    s.users.alice = () => alice.promise
    s.users.bob = async () => user(8, 'bob', 'Bob Current')
    s.params = { username: 'alice' }
    const { rerender } = render(<Profile />)
    // Same component instance, new route param — what react-router does.
    s.params = { username: 'bob' }
    rerender(<Profile />)
    await waitFor(() => expect(screen.getAllByText('Bob Current').length).toBeGreaterThan(0))
    await act(async () => { alice.resolve(user(7, 'alice', 'Alice Previous')) })
    await new Promise(r => setTimeout(r, 50))
    expect(screen.queryAllByText('Alice Previous')).toHaveLength(0)
    expect(screen.getAllByText('Bob Current').length).toBeGreaterThan(0)
    expect(userFetches()).toEqual(['/api/users/alice', '/api/users/bob'])
  })
})

describe('Profile: the viewer\'s own offer', () => {
  const offer = (offerId: number, paymentToken: string, amount: string): Json => ({
    id: offerId, offerId, tokenId: 9, offerer: s.VIEWER, paymentToken, paymentAddress: '0x0',
    amount, expiry: '2027-01-01T00:00:00.000Z', status: 'ACTIVE', username: 'carol', txHash: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  })
  // Same options as the page's fmtPrice, so the check doesn't depend on the locale.
  const two = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const caw = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 })
  const eth = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })

  it('shows USDC, USDT, CAW and ETH amounts in token units', async () => {
    s.users.carol = async () => user(9, 'carol', 'Carol')
    s.offers = [
      offer(1, 'USDC', '1500000'),
      offer(2, 'USDT', '25000000'),
      offer(3, 'CAW', '1000000000000000000000000'),
      offer(4, 'ETH', '1230000000000000000'),
    ]
    s.params = { username: 'carol' }
    render(<Profile />)
    await waitFor(() => expect(screen.getAllByText(/^Your offer:/)).toHaveLength(4))
    const shown = screen.getAllByText(/^Your offer:/).map(el => el.textContent)
    expect(shown).toEqual([
      `Your offer: ${two(1.5)} USDC`,
      `Your offer: ${two(25)} USDT`,
      `Your offer: ${caw(1000000)} CAW`,
      `Your offer: ${eth(1.23)} ETH`,
    ])
  })
})

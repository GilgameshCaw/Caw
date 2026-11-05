import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const s = vi.hoisted(() => ({
  OWNER: '0x1111111111111111111111111111111111111111',
  account: { address: undefined as string | undefined, isConnected: false },
  walletClient: null as unknown,
  recovery: { privateKey: null as string | null, address: null as string | null, isInRecoveryMode: false },
  signMessageAsync: vi.fn(async () => '0x' + 'ab'.repeat(65)),
  signDigestForOnChain: vi.fn(async () => '0x' + 'cd'.repeat(65)),
  signWithPasskeyDiscoverable: vi.fn(),
  apiFetch: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useAccount: () => s.account,
  useChainId: () => 84532,
  useSignMessage: () => ({ signMessageAsync: s.signMessageAsync }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useWalletClient: () => ({ data: s.walletClient }),
  usePublicClient: () => ({ getCode: async () => null }),
}))
vi.mock('wagmi/chains', () => ({ baseSepolia: { id: 84532 }, sepolia: { id: 11155111 }, mainnet: { id: 1 }, base: { id: 8453 } }))
vi.mock('@wagmi/core', () => ({ reconnect: vi.fn(), readContract: vi.fn(async () => []) }))
vi.mock('~/config/wagmiConfig', () => ({ wagmiConfig: {} }))
vi.mock('~/config/Web3Provider', () => ({ wagmiConfig: {} }))
vi.mock('~/store/connectModalStore', () => ({ useConnectModalStore: (sel: (x: { requestOpen: unknown }) => unknown) => sel({ requestOpen: vi.fn() }) }))
vi.mock('~/api/client', () => ({ apiFetch: s.apiFetch, retryOnIndexing: (f: () => unknown) => f() }))
vi.mock('~/api/actions', () => ({ useSignAndSubmitAction: () => vi.fn(), getCurrentMarketTip: vi.fn() }))
vi.mock('~/components/modals/QRModal', () => ({ default: () => null }))
vi.mock('~/components/identity/RecoveryProvider', () => ({ useRecoveryContext: () => s.recovery }))
vi.mock('~/components/identity/IdentitySigningProvider', () => ({ useIdentitySigning: () => ({ startSigning: vi.fn(), stopSigning: vi.fn() }) }))
vi.mock('~/services/identity/passkey', () => ({ signWithPasskey: vi.fn(), signWithPasskeyDiscoverable: s.signWithPasskeyDiscoverable }))
vi.mock('~/services/identity/secp256k1Key', () => ({ signDigestForOnChain: s.signDigestForOnChain }))
vi.mock('~/services/identity/prf', () => ({ buildPrfSalt: vi.fn(async () => undefined), prfSecretToAesKey: vi.fn() }))
vi.mock('~/services/identity/backupBlob', () => ({ decryptBackupBlobWithKey: vi.fn(), validatePrfBackupBlobShape: vi.fn() }))
vi.mock('~/services/DmCryptoService', () => ({ hasCachedKeyPair: () => false, deriveKeyPair: vi.fn() }))
vi.mock('~/hooks/useSessionKey', () => ({
  useRestoreRoamedSession: () => vi.fn(async () => false),
  useWrapSessionForRoaming: () => vi.fn(async () => {}),
}))
vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: true }) }))
vi.mock('~/i18n/I18nProvider', () => ({ useT: () => (k: string) => k }))

import SponsorInviteSection from '~/components/sponsor/SponsorInviteSection'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { useAuthStore } from '~/store/authStore'
import { persistPasskeyIdentity } from '~/constants/passkeyStorage'

function seedProfile(passkey: boolean) {
  const tds = useTokenDataStore.getState()
  tds.setTokensForAddress(s.OWNER as `0x${string}`, [{
    tokenId: 7, username: 'alice', address: s.OWNER, owner: s.OWNER,
    withdrawable: 0n, ownerBalance: 0n, stakedAmount: 0n, cawonce: 0,
  } as never])
  tds.setActiveTokenIdForAddress(s.OWNER as `0x${string}`, 7)
  tds.setLastAddress(s.OWNER.toLowerCase())
  if (passkey) persistPasskeyIdentity(7, s.OWNER, 'cred-1')
}

const authCalls = () => s.apiFetch.mock.calls.map(c => c[0] as string).filter(u => u.startsWith('/api/auth/'))

async function pressSignIn() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter><SponsorInviteSection /></MemoryRouter>
    </QueryClientProvider>,
  )
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in' })) })
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
}

describe('SponsorInviteSection sign-in', () => {
  beforeEach(() => {
    localStorage.clear()
    useAuthStore.getState().clearSession()
    s.signMessageAsync.mockClear()
    s.signDigestForOnChain.mockClear()
    s.account = { address: undefined, isConnected: false }
    s.walletClient = null
    s.recovery = { privateKey: null, address: null, isInRecoveryMode: false }
    s.signWithPasskeyDiscoverable.mockReset()
    s.signWithPasskeyDiscoverable.mockResolvedValue({ sig: '0xaa', credentialId: 'cred-1' })
    s.apiFetch.mockReset()
    s.apiFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/users/')) return { tokenId: 7, address: s.OWNER, isPasskey: true }
      if (url === '/api/auth/verify-passkey/challenge') return { challenge: '0x' + '11'.repeat(32) }
      if (url.startsWith('/api/auth/')) return { sessionToken: 't', authorizedTokenIds: [7], authorizedAddresses: [s.OWNER], expiresAt: 1 }
      if (url === '/api/sponsor/invite-quote') {
        return { gasFloorCaw: '1', gasMarginCaw: '1', maxGiftCaw: '0', cawUsdRate: 0, perActionCaw: '1', priceAvailable: false, validatorTokenId: null }
      }
      return { codes: [], total: 0, hasMore: false }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('a passkey user signs in with the passkey', async () => {
    seedProfile(true)
    await pressSignIn()
    expect(s.signWithPasskeyDiscoverable).toHaveBeenCalledTimes(1)
    expect(authCalls()).toEqual(['/api/auth/verify-passkey/challenge', '/api/auth/verify-passkey'])
    expect(useAuthStore.getState().authorizedTokenIds).toContain(7)
    expect(screen.queryByText(/vault password/)).toBeNull()
  })

  it('shows the error when the passkey prompt is dismissed', async () => {
    seedProfile(true)
    Object.defineProperty(navigator, 'credentials', { value: { get: vi.fn() }, configurable: true })
    s.signWithPasskeyDiscoverable.mockRejectedValue(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    await pressSignIn()
    Reflect.deleteProperty(navigator, 'credentials')
    expect(screen.getByText('passkey_signin.error.cancelled')).toBeTruthy()
    expect(useAuthStore.getState().sessionToken).toBeFalsy()
  })

  it('disables the button while the passkey prompt is up', async () => {
    seedProfile(true)
    let answer: (v: unknown) => void = () => {}
    s.signWithPasskeyDiscoverable.mockImplementation(() => new Promise(r => { answer = r }))
    await pressSignIn()
    const button = screen.getByRole('button', { name: 'Signing in…' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await act(async () => { answer({ sig: '0xaa', credentialId: 'cred-1' }) })
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  })

  it('recovery mode signs the message with the recovery key', async () => {
    seedProfile(true)
    s.recovery = { privateKey: '0x' + '22'.repeat(32), address: s.OWNER, isInRecoveryMode: true }
    await pressSignIn()
    expect(s.signDigestForOnChain).toHaveBeenCalledTimes(1)
    expect(authCalls()).toEqual(['/api/auth/verify'])
    expect(s.signWithPasskeyDiscoverable).not.toHaveBeenCalled()
  })

  it('a wallet user signs the message with the wallet', async () => {
    seedProfile(false)
    s.account = { address: s.OWNER, isConnected: true }
    s.walletClient = {}
    await pressSignIn()
    expect(s.signMessageAsync).toHaveBeenCalledTimes(1)
    expect(authCalls()).toEqual(['/api/auth/verify'])
    expect(s.signWithPasskeyDiscoverable).not.toHaveBeenCalled()
  })
})

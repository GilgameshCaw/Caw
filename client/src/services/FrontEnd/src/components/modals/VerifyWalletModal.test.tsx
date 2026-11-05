import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'

const s = vi.hoisted(() => ({
  OWNER: '0x1111111111111111111111111111111111111111',
  STRAY: '0x2222222222222222222222222222222222222222',
  account: { address: undefined as string | undefined, isConnected: false },
  walletClient: null as unknown,
  recovery: { privateKey: null as string | null, address: null as string | null, isInRecoveryMode: false },
  signMessageAsync: vi.fn(async () => '0x' + 'ab'.repeat(65)),
  signDigestForOnChain: vi.fn(async () => '0x' + 'cd'.repeat(65)),
  signWithPasskeyDiscoverable: vi.fn(),
  apiFetch: vi.fn(),
  requestOpen: vi.fn(),
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
vi.mock('~/store/connectModalStore', () => ({
  useConnectModalStore: (sel: (x: { requestOpen: unknown }) => unknown) => sel({ requestOpen: s.requestOpen }),
}))
vi.mock('~/api/client', () => ({ apiFetch: s.apiFetch, retryOnIndexing: (f: () => unknown) => f() }))
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

import VerifyWalletModal from '~/components/modals/VerifyWalletModal'
import { useVerifyWalletStore } from '~/store/verifyWalletStore'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { useAuthStore } from '~/store/authStore'
import { persistPasskeyIdentity } from '~/constants/passkeyStorage'

const SESSION = { sessionToken: 't', authorizedTokenIds: [7], authorizedAddresses: [s.OWNER], expiresAt: 1 }

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

let path = ''
function Where() { path = useLocation().pathname; return null }
function Tree() {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/home']}>
        <Where />
        <VerifyWalletModal />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const onSuccess = vi.fn()
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)) })
const called = () => s.apiFetch.mock.calls.map(c => c[0])
const isOpen = () => useVerifyWalletStore.getState().isOpen

async function open() {
  const view = render(<Tree />)
  act(() => { useVerifyWalletStore.getState().show(onSuccess) })
  await settle()
  return view
}
async function press(label: string) {
  await act(async () => { fireEvent.click(screen.getByText(label)) })
  await settle()
}

describe('VerifyWalletModal', () => {
  beforeEach(() => {
    localStorage.clear()
    useVerifyWalletStore.getState().close()
    useAuthStore.getState().clearSession()
    onSuccess.mockClear()
    s.requestOpen.mockClear()
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
      return SESSION
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => { cleanup(); Reflect.deleteProperty(navigator, 'credentials'); vi.restoreAllMocks() })

  function expectPasskeySignIn() {
    expect(s.signWithPasskeyDiscoverable).toHaveBeenCalledTimes(1)
    expect(called()).toEqual(expect.arrayContaining(['/api/users/alice', '/api/auth/verify-passkey']))
    expect(called()).not.toContain('/api/auth/verify')
    expect(s.signMessageAsync).not.toHaveBeenCalled()
    expect(useAuthStore.getState().sessionToken).toBe('t')
    expect(isOpen()).toBe(false)
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(path).toBe('/home')
  }

  it('a passkey user with no wallet signs in with the passkey, in place', async () => {
    seedProfile(true)
    await open()
    expect(screen.queryByText('verify_wallet.body')).toBeNull()
    await press('passkey_signin.cta')
    expectPasskeySignIn()
    expect(s.requestOpen).not.toHaveBeenCalled()
  })

  it('a passkey user with an unrelated wallet connected signs in with the passkey', async () => {
    seedProfile(true)
    s.account = { address: s.STRAY, isConnected: true }
    s.walletClient = {}
    await open()
    await press('passkey_signin.cta')
    expectPasskeySignIn()
  })

  it('stays open and shows the error when the passkey prompt is dismissed', async () => {
    seedProfile(true)
    // jsdom has no WebAuthn; the hook would report 'unsupported' instead of 'cancelled'.
    Object.defineProperty(navigator, 'credentials', { value: { get: vi.fn() }, configurable: true })
    s.signWithPasskeyDiscoverable.mockRejectedValue(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    await open()
    await press('passkey_signin.cta')
    expect(screen.getByText('passkey_signin.error.cancelled')).toBeTruthy()
    expect(isOpen()).toBe(true)
    expect(onSuccess).not.toHaveBeenCalled()
    expect(useAuthStore.getState().sessionToken).toBeFalsy()
  })

  it('disables the button while the passkey prompt is up', async () => {
    seedProfile(true)
    let answer: (v: unknown) => void = () => {}
    s.signWithPasskeyDiscoverable.mockImplementation(() => new Promise(r => { answer = r }))
    await open()
    await press('passkey_signin.cta')
    const button = screen.getByText('passkey_signin.signing') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await act(async () => { fireEvent.click(button) })
    expect(s.signWithPasskeyDiscoverable).toHaveBeenCalledTimes(1)
    await act(async () => { answer({ sig: '0xaa', credentialId: 'cred-1' }) })
    await settle()
    expect(isOpen()).toBe(false)
  })

  it('recovery mode signs the message with the recovery key, with no wallet and no passkey prompt', async () => {
    seedProfile(true)
    s.recovery = { privateKey: '0x' + '22'.repeat(32), address: s.OWNER, isInRecoveryMode: true }
    await open()
    await press('verify_wallet.btn.verify')
    expect(s.signDigestForOnChain).toHaveBeenCalledTimes(1)
    expect(called()).toEqual(['/api/auth/verify'])
    expect(s.signWithPasskeyDiscoverable).not.toHaveBeenCalled()
    expect(s.requestOpen).not.toHaveBeenCalled()
    expect(isOpen()).toBe(false)
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(path).toBe('/home')
  })

  it('a wallet user with the right wallet signs the message', async () => {
    seedProfile(false)
    s.account = { address: s.OWNER, isConnected: true }
    s.walletClient = {}
    await open()
    expect(screen.getByText('verify_wallet.body')).toBeTruthy()
    await press('verify_wallet.btn.verify')
    expect(s.signMessageAsync).toHaveBeenCalledTimes(1)
    expect(called()).toEqual(['/api/auth/verify'])
    expect(s.signWithPasskeyDiscoverable).not.toHaveBeenCalled()
    expect(isOpen()).toBe(false)
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })

  it('a wallet user with no wallet gets the chooser, then verifies once connected', async () => {
    seedProfile(false)
    const view = await open()
    await press('verify_wallet.btn.verify')
    expect(s.requestOpen).toHaveBeenCalledWith('connect')
    expect(path).toBe('/home')
    expect(called()).toEqual([])
    expect(isOpen()).toBe(true)

    s.account = { address: s.OWNER, isConnected: true }
    s.walletClient = {}
    view.rerender(<Tree />)
    await settle()
    expect(s.signMessageAsync).toHaveBeenCalledTimes(1)
    expect(called()).toEqual(['/api/auth/verify'])
    expect(isOpen()).toBe(false)
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })
})

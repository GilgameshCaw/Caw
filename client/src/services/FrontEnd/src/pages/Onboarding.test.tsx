/**
 * Onboarding.test.tsx
 *
 * Tests for the Onboarding page state machine and step components.
 *
 * Uses Vitest + @testing-library/react.
 * Wagmi hooks are mocked so no real RPC calls are made.
 *
 * Strategy for the username debounce:
 *   UsernameStep debounces username queries by 500ms. Tests use
 *   vi.useFakeTimers() + vi.runAllTimers() to flush the debounce
 *   synchronously, then re-wrap assertions in act() so React flushes
 *   pending state updates before we assert.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: undefined, isConnected: false })),
  usePublicClient: vi.fn(() => null),
  useReadContract: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    error: null,
  })),
}))

vi.mock('~/hooks/useTheme', () => ({
  useTheme: vi.fn(() => ({ isDark: true, toggle: vi.fn() })),
}))

vi.mock('~/i18n/I18nProvider', () => ({
  useT: vi.fn(() => (key: string, vars?: Record<string, string>) => {
    if (vars) return `${key}:${JSON.stringify(vars)}`
    return key
  }),
}))

vi.mock('~/store/tokenDataStore', () => ({
  usePriceStore: vi.fn(() => ({ priceMap: {} })),
}))

vi.mock('~/../../../abi/generated', () => ({
  cawProfileMinterAbi: [],
}))

vi.mock('~/../../../abi/addresses', () => ({
  CAW_NAMES_MINTER_ADDRESS: '0x0000000000000000000000000000000000000001',
}))

vi.mock('~/config/chains', () => ({
  chains: { l1: { chainId: 11155111 }, l2: { chainId: 84532, layerZero: 40245 } },
}))

vi.mock('~/utils/localizedRouter', () => ({
  useNavigate: vi.fn(() => vi.fn()),
  Link: ({ children }: { children: React.ReactNode }) => React.createElement('a', null, children),
}))

// ─── Identity service mocks ────────────────────────────────────────────────────

const mockEnrollPasskey = vi.fn()
const mockBootstrapNewUser = vi.fn()
const mockDownloadBackupBlob = vi.fn()
const mockSignWithPasskey = vi.fn()
const mockGetSponsorApiClient = vi.fn()

vi.mock('~/services/identity/passkey', () => ({
  enrollPasskey: (...args: unknown[]) => mockEnrollPasskey(...args),
  signWithPasskey: (...args: unknown[]) => mockSignWithPasskey(...args),
}))

vi.mock('~/services/identity/bootstrap', () => ({
  bootstrapNewUser: (...args: unknown[]) => mockBootstrapNewUser(...args),
}))

vi.mock('~/services/identity/cloudBackup', () => ({
  downloadBackupBlob: (...args: unknown[]) => mockDownloadBackupBlob(...args),
}))

vi.mock('~/services/identity/sponsorApiClient', () => ({
  getSponsorApiClient: (...args: unknown[]) => mockGetSponsorApiClient(...args),
  isSponsorSuccess: (r: unknown) => 'txHash' in (r as object),
}))

vi.mock('~/services/identity/eip712Permits', () => ({
  buildMintDepositPermitDigest: vi.fn(() => '0xdeadbeef' as `0x${string}`),
  buildDepositForPermitDigest: vi.fn(() => '0xdeadbeef00' as `0x${string}`),
  buildAuthenticatePermitDigest: vi.fn(() => '0xdeadbeef01' as `0x${string}`),
}))

// ─── Test helpers ──────────────────────────────────────────────────────────────

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children)
}

import * as wagmiMod from 'wagmi'
const mockUseReadContract = wagmiMod.useReadContract as ReturnType<typeof vi.fn>

// ─── Onboarding step machine tests ────────────────────────────────────────────

import Onboarding from './Onboarding'

describe('Onboarding state machine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    // Default: username is available (idByUsername returns 0)
    mockUseReadContract.mockReturnValue({ data: 0, isLoading: false, error: null })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Helper: type a valid username and advance the debounce so the
  // availability check completes. Uses fireEvent.change (no timer cost)
  // then advances fake timers past the 500ms debounce.
  async function typeUsernameAndFlush(username: string) {
    const input = screen.getByPlaceholderText('onboarding.username.placeholder')
    await act(async () => {
      fireEvent.change(input, { target: { value: username } })
      // Advance past the 500ms debounce
      vi.advanceTimersByTime(600)
    })
  }

  // Helper: navigate from username step to deposit step
  async function navigateToDeposit() {
    await typeUsernameAndFlush('alice')
    await act(async () => {
      fireEvent.click(screen.getByText('common.next'))
    })
  }

  // Helper: navigate from username → deposit → vault-password
  async function navigateToVault() {
    await navigateToDeposit()
    await act(async () => {
      // Click the Next button on deposit (default 1M CAW is valid)
      const nextBtns = screen.getAllByText('common.next')
      fireEvent.click(nextBtns[0])
    })
  }

  // Helper: navigate through to the passkey step
  async function navigateToPasskey() {
    await navigateToVault()
    await act(async () => {
      const pwInput = screen.getByPlaceholderText('onboarding.vault.password_placeholder')
      fireEvent.change(pwInput, { target: { value: 'Str0ngPassword!' } })
      const confirmInput = screen.getByPlaceholderText('onboarding.vault.confirm_placeholder')
      fireEvent.change(confirmInput, { target: { value: 'Str0ngPassword!' } })
    })
    await act(async () => {
      fireEvent.click(screen.getAllByText('common.next')[0])
    })
  }

  it('renders the username step on initial load', () => {
    render(React.createElement(Onboarding), { wrapper: makeWrapper() })
    expect(screen.getByText('onboarding.username.title')).toBeInTheDocument()
  })

  it('username Next is disabled when availability is null (no check performed)', () => {
    // useReadContract returns loading state so availability stays null
    mockUseReadContract.mockReturnValue({ data: undefined, isLoading: true, error: null })
    render(React.createElement(Onboarding), { wrapper: makeWrapper() })
    const nextBtn = screen.getByText('common.next')
    expect(nextBtn).toBeDisabled()
  })

  it('username Next is disabled when name is taken (existingId !== 0)', async () => {
    // Username taken: existingId = 1
    mockUseReadContract.mockReturnValue({ data: 1, isLoading: false, error: null })
    render(React.createElement(Onboarding), { wrapper: makeWrapper() })
    await typeUsernameAndFlush('alice')
    const nextBtn = screen.getByText('common.next')
    expect(nextBtn).toBeDisabled()
  })

  it('advances from username to deposit when availability is true', async () => {
    mockUseReadContract.mockReturnValue({ data: 0, isLoading: false, error: null })
    render(React.createElement(Onboarding), { wrapper: makeWrapper() })
    await typeUsernameAndFlush('alice')
    const nextBtn = screen.getByText('common.next')
    expect(nextBtn).not.toBeDisabled()
    await act(async () => { fireEvent.click(nextBtn) })
    expect(screen.getByText('onboarding.deposit.title')).toBeInTheDocument()
  })

  it('deposit Next is disabled when amount is below minimum', async () => {
    mockUseReadContract.mockReturnValue({ data: 0, isLoading: false, error: null })
    render(React.createElement(Onboarding), { wrapper: makeWrapper() })
    await navigateToDeposit()

    // Find the text input (not the range slider) — both show 1000000 initially.
    // The text input is inputMode="numeric", not type="range".
    const allInputs = screen.getAllByDisplayValue('1000000')
    const amountInput = allInputs.find(
      (el): el is HTMLInputElement =>
        el instanceof HTMLInputElement && el.type !== 'range'
    )!
    expect(amountInput).toBeDefined()

    // Change to below-minimum — DON'T blur (blur snaps back to min).
    // Validate disabled state while value is in-flight below minimum.
    await act(async () => {
      fireEvent.change(amountInput, { target: { value: '500000' } })
    })

    const nextBtns = screen.getAllByText('common.next')
    expect(nextBtns[0]).toBeDisabled()
  })

  it('deposit Next is enabled when amount meets minimum', async () => {
    mockUseReadContract.mockReturnValue({ data: 0, isLoading: false, error: null })
    render(React.createElement(Onboarding), { wrapper: makeWrapper() })
    await navigateToDeposit()

    // Default initial value is 1M CAW (above minimum) — Next should be enabled
    const nextBtns = screen.getAllByText('common.next')
    expect(nextBtns[0]).not.toBeDisabled()
  })

  it('navigates deposit → vault-password step via Next', async () => {
    mockUseReadContract.mockReturnValue({ data: 0, isLoading: false, error: null })
    render(React.createElement(Onboarding), { wrapper: makeWrapper() })
    await navigateToDeposit()
    await act(async () => {
      fireEvent.click(screen.getAllByText('common.next')[0])
    })
    expect(screen.getByText('onboarding.vault.title')).toBeInTheDocument()
  })

  it('vault Next is disabled when password is too short', async () => {
    mockUseReadContract.mockReturnValue({ data: 0, isLoading: false, error: null })
    render(React.createElement(Onboarding), { wrapper: makeWrapper() })
    await navigateToVault()

    await act(async () => {
      const pwInput = screen.getByPlaceholderText('onboarding.vault.password_placeholder')
      fireEvent.change(pwInput, { target: { value: 'short' } })
      const confirmInput = screen.getByPlaceholderText('onboarding.vault.confirm_placeholder')
      fireEvent.change(confirmInput, { target: { value: 'short' } })
    })

    expect(screen.getAllByText('common.next')[0]).toBeDisabled()
  })

  it('vault Next is disabled when passwords do not match', async () => {
    mockUseReadContract.mockReturnValue({ data: 0, isLoading: false, error: null })
    render(React.createElement(Onboarding), { wrapper: makeWrapper() })
    await navigateToVault()

    await act(async () => {
      const pwInput = screen.getByPlaceholderText('onboarding.vault.password_placeholder')
      fireEvent.change(pwInput, { target: { value: 'correcthorsebatterystaple' } })
      const confirmInput = screen.getByPlaceholderText('onboarding.vault.confirm_placeholder')
      fireEvent.change(confirmInput, { target: { value: 'different-password' } })
    })

    expect(screen.getAllByText('common.next')[0]).toBeDisabled()
  })

  it('vault Next is enabled with valid 12+ char matching passwords', async () => {
    mockUseReadContract.mockReturnValue({ data: 0, isLoading: false, error: null })
    render(React.createElement(Onboarding), { wrapper: makeWrapper() })
    await navigateToVault()

    await act(async () => {
      const pwInput = screen.getByPlaceholderText('onboarding.vault.password_placeholder')
      fireEvent.change(pwInput, { target: { value: 'Str0ngPassword!' } })
      const confirmInput = screen.getByPlaceholderText('onboarding.vault.confirm_placeholder')
      fireEvent.change(confirmInput, { target: { value: 'Str0ngPassword!' } })
    })

    expect(screen.getAllByText('common.next')[0]).not.toBeDisabled()
  })

  it('advances vault → passkey step', async () => {
    mockUseReadContract.mockReturnValue({ data: 0, isLoading: false, error: null })
    render(React.createElement(Onboarding), { wrapper: makeWrapper() })
    await navigateToPasskey()
    expect(screen.getByText('onboarding.passkey.title')).toBeInTheDocument()
  })

  it('back button on deposit returns to username step', async () => {
    mockUseReadContract.mockReturnValue({ data: 0, isLoading: false, error: null })
    render(React.createElement(Onboarding), { wrapper: makeWrapper() })
    await navigateToDeposit()
    await act(async () => {
      fireEvent.click(screen.getByText('common.back'))
    })
    expect(screen.getByText('onboarding.username.title')).toBeInTheDocument()
  })
})

// ─── PasskeyStep tests ────────────────────────────────────────────────────────

describe('PasskeyStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockUseReadContract.mockReturnValue({ data: 0, isLoading: false, error: null })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function navigateToPasskeyStep() {
    render(React.createElement(Onboarding), { wrapper: makeWrapper() })

    // Username
    const input = screen.getByPlaceholderText('onboarding.username.placeholder')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'alice' } })
      vi.advanceTimersByTime(600)
    })
    await act(async () => { fireEvent.click(screen.getByText('common.next')) })

    // Deposit
    await act(async () => { fireEvent.click(screen.getAllByText('common.next')[0]) })

    // Vault password
    await act(async () => {
      const pwInput = screen.getByPlaceholderText('onboarding.vault.password_placeholder')
      fireEvent.change(pwInput, { target: { value: 'Str0ngPassword!' } })
      const confirmInput = screen.getByPlaceholderText('onboarding.vault.confirm_placeholder')
      fireEvent.change(confirmInput, { target: { value: 'Str0ngPassword!' } })
    })
    await act(async () => { fireEvent.click(screen.getAllByText('common.next')[0]) })

    // Now on passkey step
    expect(screen.getByText('onboarding.passkey.title')).toBeInTheDocument()
  }

  it('shows passkey title and CTA button', async () => {
    await navigateToPasskeyStep()
    expect(screen.getByText('onboarding.passkey.cta')).toBeInTheDocument()
  })

  it('advances to backup step on successful passkey enrollment', async () => {
    const fakePubkey = {
      pubkeyX: '0xaabbcc' as `0x${string}`,
      pubkeyY: '0xddeeff' as `0x${string}`,
      credentialId: 'fakecredentialid',
    }
    mockEnrollPasskey.mockResolvedValueOnce(fakePubkey)

    await navigateToPasskeyStep()
    await act(async () => {
      fireEvent.click(screen.getByText('onboarding.passkey.cta'))
    })

    expect(screen.getByText('onboarding.backup.title')).toBeInTheDocument()
  })

  it('shows error and retry button on passkey enrollment failure', async () => {
    mockEnrollPasskey.mockRejectedValueOnce(new Error('User cancelled'))

    await navigateToPasskeyStep()
    await act(async () => {
      fireEvent.click(screen.getByText('onboarding.passkey.cta'))
    })

    expect(screen.getByText('User cancelled')).toBeInTheDocument()
    expect(screen.getByText('common.try_again')).toBeInTheDocument()
  })
})

// ─── BackupStep / bootstrapNewUser error handling tests ────────────────────────

describe('BackupStep error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockUseReadContract.mockReturnValue({ data: 0, isLoading: false, error: null })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const fakePubkey = {
    pubkeyX: '0xaabbcc' as `0x${string}`,
    pubkeyY: '0xddeeff' as `0x${string}`,
    credentialId: 'fakecredentialid',
  }

  const fakeBootstrapResult = {
    txHash: '0xdeadbeef12345678',
    backupBlob: {
      version: 1 as const,
      argon2: { memorySize: 65536, iterations: 3, parallelism: 1 },
      salt: '0xabcd' as `0x${string}`,
      iv: '0x1234' as `0x${string}`,
      ciphertext: '0x5678' as `0x${string}`,
      pubkeyAddress: '0xabc123' as `0x${string}`,
    },
    ecdsaAddress: '0xabc123' as `0x${string}`,
  }

  async function navigateToBackupStep() {
    render(React.createElement(Onboarding), { wrapper: makeWrapper() })

    // Username
    const input = screen.getByPlaceholderText('onboarding.username.placeholder')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'alice' } })
      vi.advanceTimersByTime(600)
    })
    await act(async () => { fireEvent.click(screen.getByText('common.next')) })
    // Deposit
    await act(async () => { fireEvent.click(screen.getAllByText('common.next')[0]) })
    // Vault password
    await act(async () => {
      const pwInput = screen.getByPlaceholderText('onboarding.vault.password_placeholder')
      fireEvent.change(pwInput, { target: { value: 'Str0ngPassword!' } })
      const confirmInput = screen.getByPlaceholderText('onboarding.vault.confirm_placeholder')
      fireEvent.change(confirmInput, { target: { value: 'Str0ngPassword!' } })
    })
    await act(async () => { fireEvent.click(screen.getAllByText('common.next')[0]) })
    // Passkey
    mockEnrollPasskey.mockResolvedValueOnce(fakePubkey)
    await act(async () => { fireEvent.click(screen.getByText('onboarding.passkey.cta')) })
    // Now on backup step
    expect(screen.getByText('onboarding.backup.title')).toBeInTheDocument()
  }

  it('advances to confirm step on successful bootstrap', async () => {
    mockBootstrapNewUser.mockResolvedValueOnce(fakeBootstrapResult)
    mockDownloadBackupBlob.mockReturnValue(undefined)

    await navigateToBackupStep()
    await act(async () => {
      fireEvent.click(screen.getByText('onboarding.backup.cta'))
    })

    expect(screen.getByText('onboarding.confirm.title')).toBeInTheDocument()
    expect(mockDownloadBackupBlob).toHaveBeenCalledOnce()
  })

  it('shows INSUFFICIENT_FUNDS error with retry button', async () => {
    const err = new Error('Sponsor out of funds') as Error & { code: string }
    err.code = 'INSUFFICIENT_FUNDS'
    mockBootstrapNewUser.mockRejectedValueOnce(err)

    await navigateToBackupStep()
    await act(async () => {
      fireEvent.click(screen.getByText('onboarding.backup.cta'))
    })

    expect(screen.getByText('onboarding.backup.error_no_funds')).toBeInTheDocument()
    expect(screen.getByText('common.try_again')).toBeInTheDocument()
  })

  it('shows RATE_LIMITED error with retry button', async () => {
    const err = new Error('Rate limited') as Error & { code: string }
    err.code = 'RATE_LIMITED'
    mockBootstrapNewUser.mockRejectedValueOnce(err)

    await navigateToBackupStep()
    await act(async () => {
      fireEvent.click(screen.getByText('onboarding.backup.cta'))
    })

    expect(screen.getByText('onboarding.backup.error_rate_limited')).toBeInTheDocument()
    expect(screen.getByText('common.try_again')).toBeInTheDocument()
  })

  it('shows generic error with retry button for unknown errors', async () => {
    mockBootstrapNewUser.mockRejectedValueOnce(new Error('Network timeout'))

    await navigateToBackupStep()
    await act(async () => {
      fireEvent.click(screen.getByText('onboarding.backup.cta'))
    })

    // Generic error includes the error message
    const errorEl = screen.getByText((content) =>
      content.includes('onboarding.backup.error_generic') ||
      content.includes('Network timeout')
    )
    expect(errorEl).toBeInTheDocument()
    expect(screen.getByText('common.try_again')).toBeInTheDocument()
  })

  it('returns to username step on USERNAME_TAKEN error', async () => {
    const err = new Error('Username taken') as Error & { code: string }
    err.code = 'USERNAME_TAKEN'
    mockBootstrapNewUser.mockRejectedValueOnce(err)

    await navigateToBackupStep()
    await act(async () => {
      fireEvent.click(screen.getByText('onboarding.backup.cta'))
    })

    // Should be back on username step
    expect(screen.getByText('onboarding.username.title')).toBeInTheDocument()
  })
})

// ─── Action-layer population switch tests ─────────────────────────────────────

import { renderHook } from '@testing-library/react'
import { useSponsorDeposit } from '~/hooks/useSponsorDeposit'
import { useSponsorAuthenticate } from '~/hooks/useSponsorAuthenticate'

vi.mock('~/hooks/useWalletPopulation', () => ({
  useWalletPopulation: vi.fn(() => ({ population: 'A', loading: false, address: undefined })),
}))

import * as walletPopMod from '~/hooks/useWalletPopulation'
const mockUseWalletPopulation = walletPopMod.useWalletPopulation as ReturnType<typeof vi.fn>

describe('useSponsorDeposit population switch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(wagmiMod.usePublicClient as ReturnType<typeof vi.fn>).mockReturnValue(null)
    mockGetSponsorApiClient.mockReturnValue({
      sponsorDeposit: vi.fn().mockResolvedValue({ txHash: '0xabc' }),
    })
    mockSignWithPasskey.mockResolvedValue({
      sig: '0xsig',
      authenticatorData: '0xauthdata',
      clientDataJSON: '{}',
      r: '0xr',
      s: '0xs',
    })
  })

  const depositParams = {
    tokenId: 1,
    networkId: 1,
    amount: 1000n,
    permitNonce: 0n,
    credentialId: 'credid',
  }

  it('Population A: returns { population: A } without calling sponsor', async () => {
    mockUseWalletPopulation.mockReturnValue({ population: 'A', loading: false, address: '0x1' })
    const { result } = renderHook(() => useSponsorDeposit(), {
      wrapper: makeWrapper(),
    })
    const res = await result.current.deposit(depositParams)
    expect(res.population).toBe('A')
    expect(res.txHash).toBeUndefined()
  })

  it('Population B: calls sponsor and returns txHash', async () => {
    mockUseWalletPopulation.mockReturnValue({ population: 'B', loading: false, address: '0x1' })
    const mockSponsorDeposit = vi.fn().mockResolvedValue({ txHash: '0xb_hash' })
    mockGetSponsorApiClient.mockReturnValue({ sponsorDeposit: mockSponsorDeposit })

    const { result } = renderHook(() => useSponsorDeposit(), {
      wrapper: makeWrapper(),
    })
    const res = await act(async () => result.current.deposit(depositParams))
    expect(res.population).toBe('B')
    expect(res.txHash).toBe('0xb_hash')
    expect(mockSponsorDeposit).toHaveBeenCalledOnce()
  })

  it('Population C: returns error without calling sponsor', async () => {
    mockUseWalletPopulation.mockReturnValue({ population: 'C', loading: false, address: '0x1' })
    const { result } = renderHook(() => useSponsorDeposit(), {
      wrapper: makeWrapper(),
    })
    const res = await result.current.deposit(depositParams)
    expect(res.population).toBe('C')
    expect(res.error).toContain('not yet supported')
  })
})

describe('useSponsorAuthenticate population switch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(wagmiMod.usePublicClient as ReturnType<typeof vi.fn>).mockReturnValue(null)
    mockGetSponsorApiClient.mockReturnValue({
      sponsorAuthenticate: vi.fn().mockResolvedValue({ txHash: '0xabc' }),
    })
    mockSignWithPasskey.mockResolvedValue({
      sig: '0xsig',
      authenticatorData: '0xauthdata',
      clientDataJSON: '{}',
      r: '0xr',
      s: '0xs',
    })
  })

  const authParams = {
    tokenId: 1,
    networkId: 1,
    permitNonce: 0n,
    credentialId: 'credid',
  }

  it('Population A: returns { population: A } without calling sponsor', async () => {
    mockUseWalletPopulation.mockReturnValue({ population: 'A', loading: false, address: '0x1' })
    const { result } = renderHook(() => useSponsorAuthenticate(), {
      wrapper: makeWrapper(),
    })
    const res = await result.current.authenticate(authParams)
    expect(res.population).toBe('A')
    expect(res.txHash).toBeUndefined()
  })

  it('Population B: calls sponsor and returns txHash', async () => {
    mockUseWalletPopulation.mockReturnValue({ population: 'B', loading: false, address: '0x1' })
    const mockSponsorAuth = vi.fn().mockResolvedValue({ txHash: '0xb_auth_hash' })
    mockGetSponsorApiClient.mockReturnValue({ sponsorAuthenticate: mockSponsorAuth })

    const { result } = renderHook(() => useSponsorAuthenticate(), {
      wrapper: makeWrapper(),
    })
    const res = await act(async () => result.current.authenticate(authParams))
    expect(res.population).toBe('B')
    expect(res.txHash).toBe('0xb_auth_hash')
    expect(mockSponsorAuth).toHaveBeenCalledOnce()
  })

  it('Population C: returns error without calling sponsor', async () => {
    mockUseWalletPopulation.mockReturnValue({ population: 'C', loading: false, address: '0x1' })
    const { result } = renderHook(() => useSponsorAuthenticate(), {
      wrapper: makeWrapper(),
    })
    const res = await result.current.authenticate(authParams)
    expect(res.population).toBe('C')
    expect(res.error).toContain('not yet supported')
  })
})

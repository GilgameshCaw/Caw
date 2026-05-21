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
  chains: { l1: { chainId: 11155111 }, l2: { chainId: 84532 } },
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

  it('advances vault → stub next step', async () => {
    mockUseReadContract.mockReturnValue({ data: 0, isLoading: false, error: null })
    render(React.createElement(Onboarding), { wrapper: makeWrapper() })
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

    expect(screen.getByText('onboarding.next.title')).toBeInTheDocument()
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

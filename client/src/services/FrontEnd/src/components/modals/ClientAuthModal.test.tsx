/**
 * ClientAuthModal.test.tsx
 *
 * After the authenticate tx is sent, the modal retries the original action
 * before LZ has relayed the auth to L2. The authenticate tx hash has to be
 * left as the caw:pendingDeposit hint so that retry is parked in
 * waiting_for_deposit instead of being simulated into UserNotAuth.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// ─── Mock external dependencies ──────────────────────────────────────────────

const AUTH_HASH = `0x${'ab'.repeat(32)}`
const RELAY_HASH = `0x${'cd'.repeat(32)}`
const TOKEN_ID = 7
const HINT_KEY = `caw:pendingDeposit:${TOKEN_ID}`

const writeContractAsync = vi.fn(async () => AUTH_HASH)
const smartEoaExecute = vi.fn(async () => RELAY_HASH)
let mockPopulation: 'A' | 'B' = 'A'
let mockL2Balance = 10n ** 21n
let mockStakeReadHangs = false

vi.mock('wagmi', () => ({
  useWriteContract: () => ({ writeContractAsync }),
  useReadContract: () => ({ data: { nativeFee: 10n ** 15n } }),
  usePublicClient: () => ({
    readContract: async () => 10n ** 24n,
    getBalance: async () => 10n ** 18n,
  }),
}))

vi.mock('~/api/actions', () => ({
  CLIENT_ID: 1,
  readOnChainStakeForHint: vi.fn(() =>
    mockStakeReadHangs ? new Promise<bigint>(() => {}) : Promise.resolve(mockL2Balance)),
}))

vi.mock('~/api/client', () => ({
  apiFetch: vi.fn(async () => ({
    relayer: '0x0000000000000000000000000000000000000001',
    minFeeCawWei: '1',
    priceAvailable: true,
    minFeeEthWei: '1',
  })),
}))

vi.mock('~/hooks/useEnsureWallet', () => ({
  useEnsureWallet: () => async (_opts: unknown, fn: () => Promise<void>) => fn(),
}))

vi.mock('~/hooks/useWalletPopulation', () => ({
  useWalletPopulation: () => ({ population: mockPopulation }),
}))

vi.mock('~/hooks/useSmartEoaExecute', () => ({
  useSmartEoaExecute: () => ({
    execute: smartEoaExecute,
    account: '0x0000000000000000000000000000000000000002',
  }),
}))

vi.mock('~/components/modals/ModalWrapper', () => ({
  default: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div data-testid="modal-wrapper">{children}</div> : null,
}))

vi.mock('~/components/NetworkFeesPanel', () => ({ default: () => null }))

vi.mock('~/store/tokenDataStore', () => ({
  usePriceStore: (sel: (s: { priceMap: Record<string, number> }) => unknown) =>
    sel({ priceMap: { ethereum: 2000 } }),
}))

vi.mock('~/hooks/useTheme', () => ({
  useTheme: () => ({ isDark: true }),
}))

vi.mock('~/i18n/I18nProvider', () => ({
  useT: () => (key: string) => key,
}))

// ─── Import component after mocks ─────────────────────────────────────────────

import ClientAuthModal from './ClientAuthModal'
import { useClientAuthStore } from '~/store/clientAuthStore'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Open the modal, press Activate, and resolve with the hint as it was when
 *  the retry (onSuccess) ran. */
async function authenticateAndRetry(): Promise<string | null> {
  let hintAtRetry: string | null | undefined
  const onSuccess = vi.fn(() => { hintAtRetry = localStorage.getItem(HINT_KEY) })
  useClientAuthStore.getState().show(TOKEN_ID, onSuccess)
  render(<ClientAuthModal />)
  fireEvent.click(screen.getByText('client_auth.btn.activate'))
  await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1), { timeout: 6000 })
  return hintAtRetry ?? null
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ClientAuthModal', () => {
  beforeEach(() => {
    localStorage.clear()
    mockPopulation = 'A'
    mockL2Balance = 10n ** 21n
    mockStakeReadHangs = false
    writeContractAsync.mockClear()
    smartEoaExecute.mockClear()
    useClientAuthStore.setState({ isOpen: false, tokenId: undefined, onSuccess: undefined, onCancel: undefined })
  })

  it('leaves the authenticate tx hash as the pending hint before the retry', async () => {
    const hint = await authenticateAndRetry()
    expect(writeContractAsync).toHaveBeenCalledTimes(1)
    expect(hint).not.toBeNull()
    expect(JSON.parse(hint!).txHash).toBe(AUTH_HASH)
    expect(JSON.parse(hint!).amount).toBeUndefined()
  })

  it('does the same on the Pop-B relay path', async () => {
    mockPopulation = 'B'
    const hint = await authenticateAndRetry()
    expect(smartEoaExecute).toHaveBeenCalledTimes(1)
    expect(hint).not.toBeNull()
    expect(JSON.parse(hint!).txHash).toBe(RELAY_HASH)
  })

  it('leaves no hint when the L2 balance is 0', async () => {
    mockL2Balance = 0n
    const hint = await authenticateAndRetry()
    expect(hint).toBeNull()
  })

  it('does not touch an existing hint', async () => {
    const existing = JSON.stringify({ amount: '5', txHash: `0x${'ef'.repeat(32)}`, at: Date.now() })
    localStorage.setItem(HINT_KEY, existing)
    const hint = await authenticateAndRetry()
    expect(hint).toBe(existing)
  })

  it('replaces an expired hint, which the submit paths would drop', async () => {
    localStorage.setItem(HINT_KEY, JSON.stringify({
      amount: '5', txHash: `0x${'ef'.repeat(32)}`, at: Date.now() - 31 * 60 * 1000,
    }))
    const hint = await authenticateAndRetry()
    expect(JSON.parse(hint!).txHash).toBe(AUTH_HASH)
  })

  it('replaces a hint that is not a valid tx hash', async () => {
    localStorage.setItem(HINT_KEY, JSON.stringify({ txHash: '0x1234', at: Date.now() }))
    const hint = await authenticateAndRetry()
    expect(JSON.parse(hint!).txHash).toBe(AUTH_HASH)
  })

  it('still retries, without a hint, when the L2 balance read never answers', async () => {
    mockStakeReadHangs = true
    const started = Date.now()
    const hint = await authenticateAndRetry()
    expect(hint).toBeNull()
    expect(Date.now() - started).toBeLessThan(5800)
  }, 10000)
})

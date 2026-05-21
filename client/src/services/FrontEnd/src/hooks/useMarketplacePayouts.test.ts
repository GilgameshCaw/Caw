/**
 * useMarketplacePayouts.test.ts
 *
 * Tests for the V2 pull-payout hook.
 * Wagmi hooks are mocked so no real RPC calls happen.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useMarketplacePayouts } from './useMarketplacePayouts'

// ─── Mock wagmi ────────────────────────────────────────────────────────────────

vi.mock('wagmi', () => ({
  useReadContract: vi.fn(),
  useWriteContract: vi.fn(),
  useWaitForTransactionReceipt: vi.fn(),
}))

import * as wagmi from 'wagmi'

const mockUseReadContract      = wagmi.useReadContract      as ReturnType<typeof vi.fn>
const mockUseWriteContract     = wagmi.useWriteContract     as ReturnType<typeof vi.fn>
const mockUseWaitForTxReceipt  = wagmi.useWaitForTransactionReceipt as ReturnType<typeof vi.fn>

// ─── Mock ABI / address imports ───────────────────────────────────────────────

vi.mock('~/../../../abi/addresses', () => ({
  CAW_NAME_MARKETPLACE_ADDRESS: '0x6404d1D3D878407a0977d99C832453f235DA67C3',
}))
vi.mock('~/../../../abi/generated', () => ({
  cawProfileMarketplaceAbi: [],
}))
vi.mock('~/config/chains', () => ({
  chains: { l2: { chainId: 84532 } },
}))

const SELLER = '0xaAbBcCdDeEfF001122334455667788990011aabb' as `0x${string}`

function makeWriteMock(overrides = {}) {
  return {
    writeContract: vi.fn(),
    data: undefined,
    isPending: false,
    reset: vi.fn(),
    ...overrides,
  }
}

function makeReceiptMock(overrides = {}) {
  return {
    isLoading: false,
    isSuccess: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUseWriteContract.mockReturnValue(makeWriteMock())
  mockUseWaitForTxReceipt.mockReturnValue(makeReceiptMock())
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useMarketplacePayouts', () => {
  it('returns null pending while loading', () => {
    mockUseReadContract.mockReturnValue({ data: undefined, isLoading: true, refetch: vi.fn() })

    const { result } = renderHook(() => useMarketplacePayouts(SELLER))

    expect(result.current.pending).toBeNull()
    expect(result.current.loaded).toBe(false)
  })

  it('returns 0n when contract returns 0', () => {
    mockUseReadContract.mockReturnValue({ data: 0n, isLoading: false, refetch: vi.fn() })

    const { result } = renderHook(() => useMarketplacePayouts(SELLER))

    expect(result.current.pending).toBe(0n)
    expect(result.current.loaded).toBe(true)
  })

  it('returns the pending bigint from the contract', () => {
    mockUseReadContract.mockReturnValue({ data: 500n * 10n ** 18n, isLoading: false, refetch: vi.fn() })

    const { result } = renderHook(() => useMarketplacePayouts(SELLER))

    expect(result.current.pending).toBe(500n * 10n ** 18n)
    expect(result.current.loaded).toBe(true)
  })

  it('returns null pending when no sellerAddress provided', () => {
    // query is disabled; data stays undefined
    mockUseReadContract.mockReturnValue({ data: undefined, isLoading: false, refetch: vi.fn() })

    const { result } = renderHook(() => useMarketplacePayouts(undefined))

    expect(result.current.pending).toBeNull()
  })

  it('calls writeContract with withdrawPayouts when withdraw() is invoked', () => {
    const writeContract = vi.fn()
    mockUseReadContract.mockReturnValue({ data: 100n, isLoading: false, refetch: vi.fn() })
    mockUseWriteContract.mockReturnValue(makeWriteMock({ writeContract }))

    const { result } = renderHook(() => useMarketplacePayouts(SELLER))
    result.current.withdraw()

    expect(writeContract).toHaveBeenCalledOnce()
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'withdrawPayouts' })
    )
  })

  it('calls writeContract with withdrawPayoutsTo when withdrawTo() is invoked', () => {
    const writeContract = vi.fn()
    const recipient = '0x1111111111111111111111111111111111111111' as `0x${string}`
    mockUseReadContract.mockReturnValue({ data: 100n, isLoading: false, refetch: vi.fn() })
    mockUseWriteContract.mockReturnValue(makeWriteMock({ writeContract }))

    const { result } = renderHook(() => useMarketplacePayouts(SELLER))
    result.current.withdrawTo(recipient)

    expect(writeContract).toHaveBeenCalledOnce()
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'withdrawPayoutsTo',
        args: [recipient],
      })
    )
  })

  it('reflects isPending from writeContract', () => {
    mockUseReadContract.mockReturnValue({ data: 100n, isLoading: false, refetch: vi.fn() })
    mockUseWriteContract.mockReturnValue(makeWriteMock({ isPending: true }))

    const { result } = renderHook(() => useMarketplacePayouts(SELLER))

    expect(result.current.isPending).toBe(true)
  })

  it('reflects isConfirming from useWaitForTransactionReceipt', () => {
    mockUseReadContract.mockReturnValue({ data: 100n, isLoading: false, refetch: vi.fn() })
    mockUseWaitForTxReceipt.mockReturnValue(makeReceiptMock({ isLoading: true }))

    const { result } = renderHook(() => useMarketplacePayouts(SELLER))

    expect(result.current.isConfirming).toBe(true)
  })
})

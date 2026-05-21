/**
 * useWalletPopulation.test.ts
 *
 * Tests for the wallet population detection hook and its classifier helper.
 * Uses Vitest + @testing-library/react.
 *
 * Hook tests mock wagmi's useAccount + usePublicClient via vi.mock so no
 * real RPC calls happen.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { classifyBytecode, useWalletPopulation, type WalletPopulation } from './useWalletPopulation'

// ─── classifyBytecode unit tests (pure function, no mocks) ───────────────────

describe('classifyBytecode', () => {
  it('returns A for undefined', () => {
    expect(classifyBytecode(undefined)).toBe('A')
  })

  it('returns A for 0x', () => {
    expect(classifyBytecode('0x')).toBe('A')
  })

  it('returns A for empty string', () => {
    expect(classifyBytecode('')).toBe('A')
  })

  it('returns B for a valid 7702 delegation designator (23 bytes / 48 chars)', () => {
    // 0xef0100 + 20-byte address = 23 bytes = 46 hex chars + '0x' prefix
    const code = '0xef0100' + 'aAbBcCdDeEfF001122334455667788990011aabb'
    // That is '0x' + 6 (magic) + 40 (address) = 48 chars total
    expect(code.length).toBe(48)
    expect(classifyBytecode(code)).toBe('B')
  })

  it('returns C for 7702-like prefix but wrong length', () => {
    // Starts with ef0100 but is too long — not a valid 7702 designator
    const code = '0xef0100' + 'aa'.repeat(25)
    expect(classifyBytecode(code)).toBe('C')
  })

  it('returns C for arbitrary smart-contract bytecode', () => {
    // A typical ERC-20 style contract bytecode excerpt
    const code = '0x608060405234801561001057600080fd5b50'
    expect(classifyBytecode(code)).toBe('C')
  })
})

// ─── useWalletPopulation hook tests ──────────────────────────────────────────

// We mock the entire wagmi module to control account state and publicClient.
vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  usePublicClient: vi.fn(),
}))

// @tanstack/react-query is used internally by the hook; provide a real
// QueryClientProvider wrapper so the hook renders properly.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import * as wagmi from 'wagmi'

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children)
}

const mockUseAccount = wagmi.useAccount as ReturnType<typeof vi.fn>
const mockUsePublicClient = wagmi.usePublicClient as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useWalletPopulation', () => {
  it('returns none when no wallet is connected', async () => {
    mockUseAccount.mockReturnValue({ address: undefined, isConnected: false })
    mockUsePublicClient.mockReturnValue(null)

    const { result } = renderHook(() => useWalletPopulation(), {
      wrapper: makeWrapper(),
    })

    expect(result.current.population).toBe<WalletPopulation>('none')
    expect(result.current.loading).toBe(false)
    expect(result.current.address).toBeUndefined()
  })

  it('returns A (plain EOA) for address with no bytecode', async () => {
    const addr = '0x1234567890123456789012345678901234567890' as `0x${string}`
    mockUseAccount.mockReturnValue({ address: addr, isConnected: true })
    mockUsePublicClient.mockReturnValue({
      getBytecode: vi.fn().mockResolvedValue(undefined),
    })

    const { result } = renderHook(() => useWalletPopulation(), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.population).toBe<WalletPopulation>('A')
    expect(result.current.address).toBe(addr)
  })

  it('returns B (7702 delegated) for address with EIP-7702 bytecode', async () => {
    const addr = '0xaAbBcCdDeEfF001122334455667788990011aabb' as `0x${string}`
    // 23-byte 7702 designator
    const code7702 = '0xef0100' + 'aAbBcCdDeEfF001122334455667788990011aabb'
    mockUseAccount.mockReturnValue({ address: addr, isConnected: true })
    mockUsePublicClient.mockReturnValue({
      getBytecode: vi.fn().mockResolvedValue(code7702),
    })

    const { result } = renderHook(() => useWalletPopulation(), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.population).toBe<WalletPopulation>('B')
  })

  it('returns C (smart contract account) for address with non-7702 bytecode', async () => {
    const addr = '0xDeAdBeEf000000000000000000000000DeAdBeEf' as `0x${string}`
    const safeCode = '0x608060405234801561001057600080fd5b50'
    mockUseAccount.mockReturnValue({ address: addr, isConnected: true })
    mockUsePublicClient.mockReturnValue({
      getBytecode: vi.fn().mockResolvedValue(safeCode),
    })

    const { result } = renderHook(() => useWalletPopulation(), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.population).toBe<WalletPopulation>('C')
  })
})

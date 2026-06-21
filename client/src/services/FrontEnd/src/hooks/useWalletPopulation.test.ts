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
import { useTokenDataStore } from '~/store/tokenDataStore'

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

// Mock RecoveryProvider — default: not in recovery mode
const mockUseRecoveryContext = vi.fn(() => ({
  privateKey: null,
  address: null,
  isInRecoveryMode: false,
  setKey: vi.fn(),
  clearKey: vi.fn(),
}))
vi.mock('~/components/identity/RecoveryProvider', () => ({
  useRecoveryContext: () => mockUseRecoveryContext(),
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
      getCode: vi.fn().mockResolvedValue(undefined),
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
      getCode: vi.fn().mockResolvedValue(code7702),
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
      getCode: vi.fn().mockResolvedValue(safeCode),
    })

    const { result } = renderHook(() => useWalletPopulation(), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.population).toBe<WalletPopulation>('C')
  })

  it('returns B with recovery address when no wagmi account but in recovery mode', async () => {
    const recoveryAddr = '0xaAbBcCdDeEfF001122334455667788990011aabb' as `0x${string}`
    // No wagmi wallet connected
    mockUseAccount.mockReturnValue({ address: undefined, isConnected: false })
    mockUsePublicClient.mockReturnValue(null)
    // Recovery mode active
    mockUseRecoveryContext.mockReturnValue({
      privateKey: '0x4c0883a69102937d6231471b5dbb6e538eba2ef3ab91d3d82b2c54ea5d282d69' as `0x${string}`,
      address: recoveryAddr,
      isInRecoveryMode: true,
      setKey: vi.fn(),
      clearKey: vi.fn(),
    })

    const { result } = renderHook(() => useWalletPopulation(), {
      wrapper: makeWrapper(),
    })

    expect(result.current.population).toBe<WalletPopulation>('B')
    expect(result.current.address).toBe(recoveryAddr)
    expect(result.current.loading).toBe(false)
  })

  // Regression: a CONNECTED wagmi wallet whose address isn't available yet
  // (locked / initializing) must NOT classify as B even when this browser has a
  // stale passkey-install marker + a stored owner address. Returning B here
  // routed a Population-A wallet user to the backup-file signer ("needs your
  // backup file") instead of waiting for the wallet to unlock.
  it('returns none (loading) for a connected-but-locked wallet despite a passkey-install marker', async () => {
    // Stale passkey marker (now per-address) on the stored owner — the
    // contamination source. A locked wallet must still not classify as B.
    const lockedOwner = '0x1111111111111111111111111111111111111111'
    localStorage.setItem(`caw:identity-kind:${lockedOwner}`, JSON.stringify('passkey'))
    useTokenDataStore.setState({ lastAddress: lockedOwner as `0x${string}` })

    // Connected, but no address surfaced yet (wallet locked / initializing).
    mockUseAccount.mockReturnValue({ address: undefined, isConnected: true })
    mockUsePublicClient.mockReturnValue({ getCode: vi.fn() })
    mockUseRecoveryContext.mockReturnValue({
      privateKey: null, address: null, isInRecoveryMode: false, setKey: vi.fn(), clearKey: vi.fn(),
    })

    const { result } = renderHook(() => useWalletPopulation(), { wrapper: makeWrapper() })

    expect(result.current.population).toBe<WalletPopulation>('none')
    expect(result.current.loading).toBe(true)

    localStorage.removeItem(`caw:identity-kind:${lockedOwner}`)
    useTokenDataStore.setState({ lastAddress: undefined })
  })

  // Regression: a browser that once enrolled a passkey carries a browser-global
  // 'caw:identity-kind=passkey' marker. With NO wagmi wallet connected, signing
  // into a Pop-A profile (owned by a DIFFERENT, plain-EOA address than the
  // passkey owner) must NOT classify as B — else the passkey-only Wallet link /
  // backup-file signer leak onto a plain-wallet profile. Classification is
  // per-PROFILE: only the profile owned by the passkey address is B.
  it('returns none for a Pop-A profile active in a passkey-enrolled browser (mixed chooser)', async () => {
    const passkeyOwner = '0xaaaa000000000000000000000000000000000000' as `0x${string}`
    const popAOwner = '0xbbbb000000000000000000000000000000000000' as `0x${string}`
    // Per-address passkey marker on the passkey owner (the active token below is
    // owned by a DIFFERENT plain-EOA address, so it must NOT classify as B).
    localStorage.setItem(`caw:identity-kind:${passkeyOwner}`, JSON.stringify('passkey'))
    // lastAddress = the passkey owner; the ACTIVE token (id 7) is owned by the
    // Pop-A address — a different owner in the same chooser.
    useTokenDataStore.setState({
      hasHydrated: true,
      lastAddress: passkeyOwner,
      activeTokenId: 7,
      tokensByAddress: {
        [passkeyOwner]: [{ tokenId: 1, owner: passkeyOwner, address: passkeyOwner, username: 'pk', withdrawable: 0n, ownerBalance: 0n, stakedAmount: 0n, cawonce: 0 }],
        [popAOwner]: [{ tokenId: 7, owner: popAOwner, address: popAOwner, username: 'eoa', withdrawable: 0n, ownerBalance: 0n, stakedAmount: 0n, cawonce: 0 }],
      },
    })

    mockUseAccount.mockReturnValue({ address: undefined, isConnected: false })
    mockUsePublicClient.mockReturnValue(null)
    mockUseRecoveryContext.mockReturnValue({
      privateKey: null, address: null, isInRecoveryMode: false, setKey: vi.fn(), clearKey: vi.fn(),
    })

    const { result } = renderHook(() => useWalletPopulation(), { wrapper: makeWrapper() })

    expect(result.current.population).toBe<WalletPopulation>('none')

    localStorage.removeItem(`caw:identity-kind:${passkeyOwner}`)
    useTokenDataStore.setState({ hasHydrated: false, lastAddress: undefined, activeTokenId: undefined, tokensByAddress: {} })
  })

  // Counterpart: when the ACTIVE profile IS owned by the passkey address, it
  // still classifies as B (the sponsored Pop-B path is preserved).
  it('returns B for a passkey profile active in a passkey-enrolled browser', async () => {
    const passkeyOwner = '0xaaaa000000000000000000000000000000000000' as `0x${string}`
    localStorage.setItem(`caw:identity-kind:${passkeyOwner}`, JSON.stringify('passkey'))
    useTokenDataStore.setState({
      hasHydrated: true,
      lastAddress: passkeyOwner,
      activeTokenId: 1,
      tokensByAddress: {
        [passkeyOwner]: [{ tokenId: 1, owner: passkeyOwner, address: passkeyOwner, username: 'pk', withdrawable: 0n, ownerBalance: 0n, stakedAmount: 0n, cawonce: 0 }],
      },
    })

    mockUseAccount.mockReturnValue({ address: undefined, isConnected: false })
    mockUsePublicClient.mockReturnValue(null)
    mockUseRecoveryContext.mockReturnValue({
      privateKey: null, address: null, isInRecoveryMode: false, setKey: vi.fn(), clearKey: vi.fn(),
    })

    const { result } = renderHook(() => useWalletPopulation(), { wrapper: makeWrapper() })

    expect(result.current.population).toBe<WalletPopulation>('B')

    localStorage.removeItem(`caw:identity-kind:${passkeyOwner}`)
    useTokenDataStore.setState({ hasHydrated: false, lastAddress: undefined, activeTokenId: undefined, tokensByAddress: {} })
  })
})

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

  // A 7702-delegate address is only classified 'B' when THIS browser holds a
  // passkey credential for it — bytecode alone is not sufficient (see the
  // dedicated watch-only regression test below for the no-credential case).
  it('returns B (7702 delegated) for address with EIP-7702 bytecode AND a stored passkey credential', async () => {
    const addr = '0xaAbBcCdDeEfF001122334455667788990011aabb' as `0x${string}`
    // 23-byte 7702 designator
    const code7702 = '0xef0100' + 'aAbBcCdDeEfF001122334455667788990011aabb'
    localStorage.setItem('caw:passkey-credential-id:1', JSON.stringify('cred-1'))
    useTokenDataStore.setState({
      hasHydrated: true,
      lastAddress: addr,
      activeTokenId: 1,
      tokensByAddress: {
        [addr]: [{ tokenId: 1, owner: addr, address: addr, username: 'pk', withdrawable: 0n, ownerBalance: 0n, stakedAmount: 0n, cawonce: 0 }],
      },
    })
    mockUseAccount.mockReturnValue({ address: addr, isConnected: true })
    mockUsePublicClient.mockReturnValue({
      getCode: vi.fn().mockResolvedValue(code7702),
    })

    const { result } = renderHook(() => useWalletPopulation(), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.population).toBe<WalletPopulation>('B')

    localStorage.removeItem('caw:passkey-credential-id:1')
    useTokenDataStore.setState({ hasHydrated: false, lastAddress: undefined, activeTokenId: undefined, tokensByAddress: {} })
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
  // (locked / initializing) must NOT classify as B even when this browser holds
  // a passkey credential for the stored owner. Returning B here routed a
  // Population-A wallet user to the backup-file signer ("needs your backup
  // file") instead of waiting for the wallet to unlock.
  it('returns none (loading) for a connected-but-locked wallet despite a stored passkey credential', async () => {
    const lockedOwner = '0x1111111111111111111111111111111111111111'
    localStorage.setItem('caw:passkey-credential-id:1', JSON.stringify('cred-1'))
    useTokenDataStore.setState({
      hasHydrated: true,
      lastAddress: lockedOwner as `0x${string}`,
      activeTokenId: 1,
      tokensByAddress: {
        [lockedOwner]: [{ tokenId: 1, owner: lockedOwner as `0x${string}`, address: lockedOwner as `0x${string}`, username: 'pk', withdrawable: 0n, ownerBalance: 0n, stakedAmount: 0n, cawonce: 0 }],
      },
    })

    // Connected, but no address surfaced yet (wallet locked / initializing).
    mockUseAccount.mockReturnValue({ address: undefined, isConnected: true })
    mockUsePublicClient.mockReturnValue({ getCode: vi.fn() })
    mockUseRecoveryContext.mockReturnValue({
      privateKey: null, address: null, isInRecoveryMode: false, setKey: vi.fn(), clearKey: vi.fn(),
    })

    const { result } = renderHook(() => useWalletPopulation(), { wrapper: makeWrapper() })

    expect(result.current.population).toBe<WalletPopulation>('none')
    expect(result.current.loading).toBe(true)

    localStorage.removeItem('caw:passkey-credential-id:1')
    useTokenDataStore.setState({ hasHydrated: false, lastAddress: undefined, activeTokenId: undefined, tokensByAddress: {} })
  })

  // Regression: a browser that holds a passkey credential for one address must
  // NOT bleed that classification onto a DIFFERENT, plain-EOA-owned profile in
  // the same chooser (mixed Pop-A/Pop-B chooser). Classification is per-PROFILE,
  // gated on whether THIS browser can sign for the active profile's owner.
  it('returns A for a Pop-A profile active in a browser that also holds an unrelated passkey credential', async () => {
    const passkeyOwner = '0xaaaa000000000000000000000000000000000000' as `0x${string}`
    const popAOwner = '0xbbbb000000000000000000000000000000000000' as `0x${string}`
    // Credential exists for the passkey owner's token (id 1) — but the ACTIVE
    // token (id 7) is owned by a different, plain-EOA address with no credential.
    localStorage.setItem('caw:passkey-credential-id:1', JSON.stringify('cred-1'))
    useTokenDataStore.setState({
      hasHydrated: true,
      lastAddress: passkeyOwner,
      activeTokenId: 7,
      tokensByAddress: {
        [passkeyOwner]: [{ tokenId: 1, owner: passkeyOwner, address: passkeyOwner, username: 'pk', withdrawable: 0n, ownerBalance: 0n, stakedAmount: 0n, cawonce: 0 }],
        [popAOwner]: [{ tokenId: 7, owner: popAOwner, address: popAOwner, username: 'eoa', withdrawable: 0n, ownerBalance: 0n, stakedAmount: 0n, cawonce: 0 }],
      },
    })

    // The Pop-A wallet IS connected (plain EOA, no bytecode) — its own address
    // classification falls through to bytecode since no credential covers it.
    mockUseAccount.mockReturnValue({ address: popAOwner, isConnected: true })
    mockUsePublicClient.mockReturnValue({ getCode: vi.fn().mockResolvedValue(undefined) })
    mockUseRecoveryContext.mockReturnValue({
      privateKey: null, address: null, isInRecoveryMode: false, setKey: vi.fn(), clearKey: vi.fn(),
    })

    const { result } = renderHook(() => useWalletPopulation(), { wrapper: makeWrapper() })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.population).toBe<WalletPopulation>('A')

    localStorage.removeItem('caw:passkey-credential-id:1')
    useTokenDataStore.setState({ hasHydrated: false, lastAddress: undefined, activeTokenId: undefined, tokensByAddress: {} })
  })

  // Counterpart: when the ACTIVE profile's owner has a stored passkey credential
  // in this browser, it classifies as B (the sponsored Pop-B cold-load path is
  // preserved — no wagmi wallet connected at all).
  it('returns B for a passkey profile active with a stored credential, no wagmi wallet connected', async () => {
    const passkeyOwner = '0xaaaa000000000000000000000000000000000000' as `0x${string}`
    localStorage.setItem('caw:passkey-credential-id:1', JSON.stringify('cred-1'))
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
    expect(result.current.address).toBe(passkeyOwner)

    localStorage.removeItem('caw:passkey-credential-id:1')
    useTokenDataStore.setState({ hasHydrated: false, lastAddress: undefined, activeTokenId: undefined, tokensByAddress: {} })
  })

  // Regression: roamed to a new browser that happens to have an UNRELATED wagmi
  // EOA connected. The passkey profile is active (credential present), but a
  // different wallet is connected. Without the credential-first branch we'd
  // classify by the connected EOA's bytecode (plain → 'A'), route DM / Quick
  // Sign through the wrong wallet, and the roamed session/DM would never
  // restore. Must classify as B and surface the passkey owner, NOT the wallet.
  it('returns B (+passkey owner address) for a passkey profile active while an unrelated EOA is connected', async () => {
    const passkeyOwner = '0xaaaa000000000000000000000000000000000000' as `0x${string}`
    const strayEoa = '0xf71338f3eaa483aa66125598b09ba1988e694a95' as `0x${string}`
    localStorage.setItem('caw:passkey-credential-id:1', JSON.stringify('cred-1'))
    useTokenDataStore.setState({
      hasHydrated: true,
      lastAddress: passkeyOwner,
      activeTokenId: 1,
      tokensByAddress: {
        [passkeyOwner]: [{ tokenId: 1, owner: passkeyOwner, address: passkeyOwner, username: 'pk', withdrawable: 0n, ownerBalance: 0n, stakedAmount: 0n, cawonce: 0 }],
      },
    })

    // A stray plain-EOA wallet is connected via wagmi (empty bytecode).
    mockUseAccount.mockReturnValue({ address: strayEoa, isConnected: true })
    mockUsePublicClient.mockReturnValue({ getCode: vi.fn().mockResolvedValue(undefined) })
    mockUseRecoveryContext.mockReturnValue({
      privateKey: null, address: null, isInRecoveryMode: false, setKey: vi.fn(), clearKey: vi.fn(),
    })

    const { result } = renderHook(() => useWalletPopulation(), { wrapper: makeWrapper() })

    // Classifies as the passkey account, not the connected stray EOA.
    expect(result.current.population).toBe<WalletPopulation>('B')
    // And surfaces the passkey owner so downstream owner checks compare correctly.
    expect(result.current.address).toBe(passkeyOwner)

    localStorage.removeItem('caw:passkey-credential-id:1')
    useTokenDataStore.setState({ hasHydrated: false, lastAddress: undefined, activeTokenId: undefined, tokensByAddress: {} })
  })

  // The scenario from the bug report: a profile is TRANSFERRED between two of
  // the user's own passkey addresses (P1 -> P2), both of which have passkey
  // credentials enrolled in THIS browser. The transferred profile keeps its own
  // tokenId, so its credential survives the transfer and it must classify as B
  // immediately — no re-enrollment, no dependency on a single "last passkey
  // owner" marker.
  it('returns B for a profile transferred between two passkey addresses this browser controls', async () => {
    const p1 = '0xaaaa000000000000000000000000000000000000' as `0x${string}`
    const p2 = '0xbbbb000000000000000000000000000000000000' as `0x${string}`
    // Both addresses have credentials in this browser (tokenId 1 under P1,
    // tokenId 99 transferred into P2).
    localStorage.setItem('caw:passkey-credential-id:1', JSON.stringify('cred-p1'))
    localStorage.setItem('caw:passkey-credential-id:99', JSON.stringify('cred-p2'))
    useTokenDataStore.setState({
      hasHydrated: true,
      // lastAddress still points at P1 (stale/global) — must not matter.
      lastAddress: p1,
      activeTokenId: 99,
      tokensByAddress: {
        [p1]: [{ tokenId: 1, owner: p1, address: p1, username: 'pk1', withdrawable: 0n, ownerBalance: 0n, stakedAmount: 0n, cawonce: 0 }],
        [p2]: [{ tokenId: 99, owner: p2, address: p2, username: 'pk2-transferred', withdrawable: 0n, ownerBalance: 0n, stakedAmount: 0n, cawonce: 0 }],
      },
    })

    mockUseAccount.mockReturnValue({ address: undefined, isConnected: false })
    mockUsePublicClient.mockReturnValue(null)
    mockUseRecoveryContext.mockReturnValue({
      privateKey: null, address: null, isInRecoveryMode: false, setKey: vi.fn(), clearKey: vi.fn(),
    })

    const { result } = renderHook(() => useWalletPopulation(), { wrapper: makeWrapper() })

    expect(result.current.population).toBe<WalletPopulation>('B')
    expect(result.current.address).toBe(p2)

    localStorage.removeItem('caw:passkey-credential-id:1')
    localStorage.removeItem('caw:passkey-credential-id:99')
    useTokenDataStore.setState({ hasHydrated: false, lastAddress: undefined, activeTokenId: undefined, tokensByAddress: {} })
  })

  // Watch-only case: a passkey (7702) address added to another wallet as a
  // VIEWER, with NO passkey credential enrolled in this browser. Even though
  // the address is a genuine 7702 delegate on-chain (bytecode says 'B'), this
  // browser cannot produce a signature for it — must classify as 'A', not 'B'.
  it('returns A for a watch-only 7702 address with no local passkey credential', async () => {
    const watchOnlyAddr = '0xaAbBcCdDeEfF001122334455667788990011aabb' as `0x${string}`
    const code7702 = '0xef0100' + 'aAbBcCdDeEfF001122334455667788990011aabb'
    useTokenDataStore.setState({
      hasHydrated: true,
      lastAddress: watchOnlyAddr,
      activeTokenId: 5,
      tokensByAddress: {
        [watchOnlyAddr]: [{ tokenId: 5, owner: watchOnlyAddr, address: watchOnlyAddr, username: 'viewer', withdrawable: 0n, ownerBalance: 0n, stakedAmount: 0n, cawonce: 0 }],
      },
    })
    // No credential stored for tokenId 5 — this browser never enrolled a passkey
    // for this address, it was just added as a watch-only viewer.

    mockUseAccount.mockReturnValue({ address: watchOnlyAddr, isConnected: true })
    mockUsePublicClient.mockReturnValue({ getCode: vi.fn().mockResolvedValue(code7702) })
    mockUseRecoveryContext.mockReturnValue({
      privateKey: null, address: null, isInRecoveryMode: false, setKey: vi.fn(), clearKey: vi.fn(),
    })

    const { result } = renderHook(() => useWalletPopulation(), { wrapper: makeWrapper() })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.population).toBe<WalletPopulation>('A')

    useTokenDataStore.setState({ hasHydrated: false, lastAddress: undefined, activeTokenId: undefined, tokensByAddress: {} })
  })
})

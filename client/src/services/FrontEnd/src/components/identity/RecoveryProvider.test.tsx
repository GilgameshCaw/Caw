/**
 * RecoveryProvider.test.tsx
 *
 * Tests for the in-memory secp256k1 recovery key store.
 * Verifies context value updates, clearKey, and wagmi-disconnect wipe.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React from 'react'
import { RecoveryProvider, useRecoveryContext } from './RecoveryProvider'

// Mock wagmi — we need to control isConnected
vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
}))

import * as wagmi from 'wagmi'
const mockUseAccount = wagmi.useAccount as ReturnType<typeof vi.fn>

// A secp256k1 private key produced by viem's generatePrivateKey()
const MOCK_KEY = '0x4c0883a69102937d6231471b5dbb6e538eba2ef3ab91d3d82b2c54ea5d282d69' as `0x${string}`
// Expected address derived from MOCK_KEY (pre-computed via privateKeyToAccount)
// We use any non-null string here since the unit test focus is on state mgmt.

function makeWrapper() {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(RecoveryProvider, null, children)
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: no wagmi wallet connected
  mockUseAccount.mockReturnValue({ isConnected: false })
})

describe('RecoveryProvider', () => {
  it('starts with no key in recovery mode', () => {
    const { result } = renderHook(() => useRecoveryContext(), {
      wrapper: makeWrapper(),
    })
    expect(result.current.privateKey).toBeNull()
    expect(result.current.address).toBeNull()
    expect(result.current.isInRecoveryMode).toBe(false)
  })

  it('setKey stores the private key and derives address', () => {
    const { result } = renderHook(() => useRecoveryContext(), {
      wrapper: makeWrapper(),
    })

    act(() => {
      result.current.setKey(MOCK_KEY)
    })

    expect(result.current.privateKey).toBe(MOCK_KEY)
    expect(result.current.address).not.toBeNull()
    expect(result.current.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(result.current.isInRecoveryMode).toBe(true)
  })

  it('clearKey removes the key', () => {
    const { result } = renderHook(() => useRecoveryContext(), {
      wrapper: makeWrapper(),
    })

    act(() => {
      result.current.setKey(MOCK_KEY)
    })
    expect(result.current.isInRecoveryMode).toBe(true)

    act(() => {
      result.current.clearKey()
    })
    expect(result.current.privateKey).toBeNull()
    expect(result.current.address).toBeNull()
    expect(result.current.isInRecoveryMode).toBe(false)
  })

  it('clears key when wagmi account disconnects (was connected, now not)', async () => {
    // Start connected
    mockUseAccount.mockReturnValue({ isConnected: true })

    const { result, rerender } = renderHook(() => useRecoveryContext(), {
      wrapper: makeWrapper(),
    })

    // Store a key while wagmi is connected
    act(() => {
      result.current.setKey(MOCK_KEY)
    })
    expect(result.current.isInRecoveryMode).toBe(true)

    // Now simulate wagmi disconnect
    mockUseAccount.mockReturnValue({ isConnected: false })
    rerender()

    expect(result.current.privateKey).toBeNull()
    expect(result.current.isInRecoveryMode).toBe(false)
  })

  it('does NOT clear key when wagmi was never connected and disconnects', () => {
    // Never connected — stays disconnected
    mockUseAccount.mockReturnValue({ isConnected: false })

    const { result, rerender } = renderHook(() => useRecoveryContext(), {
      wrapper: makeWrapper(),
    })

    act(() => {
      result.current.setKey(MOCK_KEY)
    })
    expect(result.current.isInRecoveryMode).toBe(true)

    // Disconnect again (was already disconnected) — should NOT wipe key
    mockUseAccount.mockReturnValue({ isConnected: false })
    rerender()

    expect(result.current.isInRecoveryMode).toBe(true)
  })
})

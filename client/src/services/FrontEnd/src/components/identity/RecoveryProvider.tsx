/**
 * RecoveryProvider.tsx
 *
 * In-memory store for a recovered secp256k1 private key.
 *
 * When a Population B user loses their device they can sign in via their
 * backup file + vault password. The decrypted private key ONLY ever lives in
 * React state — never in localStorage, sessionStorage, or IndexedDB. It is
 * wiped on wagmi account disconnect, on explicit clearKey(), and silently
 * disappears on page unload (in-memory only — intentional security/UX
 * tradeoff per v5 design).
 *
 * This is a profile-scoped credential (per feedback_human_vs_profile_scoped_credentials):
 * clearing on wallet/profile change is correct behaviour here.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useAccount } from 'wagmi'
import { privateKeyToAccount } from 'viem/accounts'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecoveryContextValue {
  /** Hex-encoded secp256k1 private key in memory only. NEVER persisted. */
  privateKey: `0x${string}` | null
  /** Ethereum address derived from privateKey. */
  address: `0x${string}` | null
  /** True while the user is operating under the recovery key. */
  isInRecoveryMode: boolean
  /** Store the recovered key in memory. Call after a successful backup-blob decrypt. */
  setKey(key: `0x${string}`): void
  /** Wipe the key from memory. Called on Disconnect or explicit user action. */
  clearKey(): void
}

// ─── Context ──────────────────────────────────────────────────────────────────

const RecoveryContext = createContext<RecoveryContextValue>({
  privateKey: null,
  address: null,
  isInRecoveryMode: false,
  setKey: () => { /* noop outside provider */ },
  clearKey: () => { /* noop outside provider */ },
})

// ─── Provider ────────────────────────────────────────────────────────────────

export const RecoveryProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [privateKey, setPrivateKey] = useState<`0x${string}` | null>(null)

  // Derive address from the key whenever the key changes.
  const address = useMemo<`0x${string}` | null>(() => {
    if (!privateKey) return null
    try {
      return privateKeyToAccount(privateKey).address
    } catch {
      return null
    }
  }, [privateKey])

  const setKey = useCallback((key: `0x${string}`) => {
    setPrivateKey(key)
  }, [])

  const clearKey = useCallback(() => {
    setPrivateKey(null)
  }, [])

  // Wagmi disconnect clears the key. The connector status goes to
  // 'disconnected' when the user explicitly disconnects or the wallet
  // session expires. We watch `isConnected` — when it flips from true
  // to false we wipe the in-memory key. Note: we only clear when a
  // wagmi account WAS connected and has now disconnected; a user who
  // has never connected a wallet but is in recovery mode should not
  // have their key cleared by wagmi.
  const { isConnected } = useAccount()
  const wasConnectedRef = React.useRef(false)
  useEffect(() => {
    if (isConnected) {
      wasConnectedRef.current = true
    } else if (wasConnectedRef.current) {
      // Transitioned from connected → disconnected: wipe recovery key.
      clearKey()
      wasConnectedRef.current = false
    }
  }, [isConnected, clearKey])

  // Page-unload wipe is implicit: React state lives only in the JS heap.
  // We don't need a beforeunload handler — the key is gone when the page
  // is. Documented here for clarity.

  const value = useMemo<RecoveryContextValue>(
    () => ({
      privateKey,
      address,
      isInRecoveryMode: privateKey !== null,
      setKey,
      clearKey,
    }),
    [privateKey, address, setKey, clearKey],
  )

  return (
    <RecoveryContext.Provider value={value}>
      {children}
    </RecoveryContext.Provider>
  )
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useRecoveryContext(): RecoveryContextValue {
  return useContext(RecoveryContext)
}

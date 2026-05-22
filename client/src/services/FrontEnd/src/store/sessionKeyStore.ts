import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { getDecryptedKey, clearDecryptedKey, initBroadcastVerification } from '~/services/sessionKeyEncryption'

export interface SessionKeyEntry {
  privateKey: `0x${string}`
  address: `0x${string}`
  ownerAddress?: string // wallet address that registered this session
  expiry: number        // unix timestamp (seconds)
  scopeBitmap: number   // uint8 — bits 0-5 for CAW..UNFOLLOW
  spendLimit?: string   // whole CAW tokens as string (for JSON serialization), 0 = unlimited
  spent?: string        // whole CAW tokens spent so far (tracked locally)
  /** Max validator tip per action (whole CAW tokens, string for JSON). 0 = no tip (opt-out).
   *  Locked at session activation to prevent validators from extracting more than the user agreed to. */
  tipCeiling?: string
  /** If true, privateKey in localStorage is encrypted ciphertext — real key is in memory only */
  encrypted?: boolean
  /** The encrypted ciphertext (stored in localStorage when encrypted=true) */
  encryptedKey?: string
}

interface SessionKeyState {
  /** Sessions keyed by owner wallet address (lowercase) */
  sessions: Record<string, SessionKeyEntry>
  /** Currently active wallet address (lowercase, set by useSessionKeyWalletGuard) */
  activeWallet: string | null
  /** User preference: use session keys or sign every action with wallet */
  enabled: boolean
  /** Whether the user has been shown the Quick Sign prompt (after first stake) */
  hasSeenPrompt: boolean

  /** Get the session for the active wallet */
  getSession: () => SessionKeyEntry | null
  /** Get the session for a specific wallet address */
  getSessionForAddress: (address: string) => SessionKeyEntry | null
  setSession: (entry: SessionKeyEntry) => void
  clearSession: () => void
  setActiveWallet: (address: string | null) => void
  setEnabled: (enabled: boolean) => void
  setHasSeenPrompt: (seen: boolean) => void
  getActiveSession: () => SessionKeyEntry | null
  /** Get active (enabled + non-expired) session for a specific wallet address */
  getActiveSessionForAddress: (address: string) => SessionKeyEntry | null
  /** Check if the active session is encrypted and needs unlocking */
  needsUnlock: () => boolean
  recordSpend: (amount: bigint) => boolean
  getRemainingLimit: () => bigint | null
}

/** Helper: get the session for the current wallet from state, resolving decrypted keys from memory */
function sessionForWallet(state: { sessions: Record<string, SessionKeyEntry>; activeWallet: string | null }): SessionKeyEntry | null {
  if (!state.activeWallet) return null
  const session = state.sessions[state.activeWallet] || null
  if (!session) return null
  if (session.encrypted) {
    const decryptedKey = getDecryptedKey(state.activeWallet)
    if (!decryptedKey) return { ...session, privateKey: '' as `0x${string}` } // key locked
    return { ...session, privateKey: decryptedKey as `0x${string}` }
  }
  return session
}

/**
 * Reactive selector: use this instead of s.session in components.
 * Usage: const session = useSessionKeySession()
 */
export function useSessionKeySession(): SessionKeyEntry | null {
  const sessions = useSessionKeyStore(s => s.sessions)
  const activeWallet = useSessionKeyStore(s => s.activeWallet)
  return sessionForWallet({ sessions, activeWallet })
}

export const useSessionKeyStore = create<SessionKeyState>()(
  persist(
    (set, get) => ({
      sessions: {},
      activeWallet: null,
      enabled: false,
      hasSeenPrompt: false,

      getSession: () => sessionForWallet(get()),

      getSessionForAddress: (address: string) => {
        const state = get()
        return state.sessions[address.toLowerCase()] || null
      },

      setSession: (entry) => {
        const wallet = (entry.ownerAddress || get().activeWallet || '').toLowerCase()
        if (!wallet) return
        set(state => ({
          sessions: {
            ...state.sessions,
            [wallet]: { spent: '0', ...entry, ownerAddress: wallet },
          },
        }))
      },

      clearSession: () => {
        const wallet = get().activeWallet
        if (wallet) {
          clearDecryptedKey(wallet)
          set(state => {
            const rest = { ...state.sessions }
            delete rest[wallet]
            return { sessions: rest, enabled: false }
          })
        } else {
          set({ sessions: {}, enabled: false })
        }
      },

      setActiveWallet: (address) => set({ activeWallet: address?.toLowerCase() || null }),

      setEnabled: (enabled) => set({ enabled }),

      setHasSeenPrompt: (seen) => set({ hasSeenPrompt: seen }),

      getActiveSession: () => {
        const state = get()
        if (!state.enabled) return null
        const session = sessionForWallet(state)
        if (!session) return null
        if (session.expiry < Date.now() / 1000) {
          state.clearSession()
          return null
        }
        // If encrypted and not yet unlocked, return null (needs unlock first)
        if (session.encrypted && !session.privateKey) return null
        return session
      },

      getActiveSessionForAddress: (address: string) => {
        const state = get()
        if (!state.enabled) return null
        const raw = state.sessions[address.toLowerCase()] || null
        if (!raw) return null
        if (raw.expiry < Date.now() / 1000) return null
        if (raw.encrypted) {
          const decryptedKey = getDecryptedKey(address)
          if (!decryptedKey) return null // needs unlock
          return { ...raw, privateKey: decryptedKey as `0x${string}` }
        }
        return raw
      },

      needsUnlock: () => {
        const state = get()
        if (!state.enabled || !state.activeWallet) return false
        const raw = state.sessions[state.activeWallet]
        if (!raw || !raw.encrypted) return false
        if (raw.expiry < Date.now() / 1000) return false
        return !getDecryptedKey(state.activeWallet)
      },

      recordSpend: (amount: bigint) => {
        const state = get()
        const session = sessionForWallet(state)
        if (!session) return false

        const limit = BigInt(session.spendLimit || '0')
        const currentSpent = BigInt(session.spent || '0')
        const newSpent = currentSpent + amount

        if (limit !== 0n && newSpent > limit) {
          return false
        }

        // Update the session in-place within the sessions map
        state.setSession({ ...session, spent: newSpent.toString() })
        return true
      },

      getRemainingLimit: () => {
        const state = get()
        const session = sessionForWallet(state)
        if (!session) return null

        const limit = BigInt(session.spendLimit || '0')
        if (limit === 0n) return null

        const spent = BigInt(session.spent || '0')
        const remaining = limit - spent
        return remaining > 0n ? remaining : 0n
      },
    }),
    {
      name: 'caw-session-keys',
      migrate: (persisted: any) => {
        // v0/v1 → v3: single session → per-wallet map
        if (persisted.session && !persisted.sessions) {
          const wallet = persisted.session.ownerAddress?.toLowerCase() || 'legacy'
          return {
            sessions: { [wallet]: persisted.session },
            activeWallet: null,
            enabled: persisted.enabled ?? false,
            hasSeenPrompt: persisted.hasSeenPrompt ?? false,
          }
        }
        // v2 had sessions map already, just pass through
        if (persisted.sessions) {
          return persisted
        }
        return persisted
      },
      version: 3,
    }
  )
)

// H-3 fix: register the ciphertext-lookup callback so that incoming
// BroadcastChannel key-response messages are verified against the stored
// ciphertext before being written into the in-memory key map.
// This runs once at module load time (after the store is created).
initBroadcastVerification((walletAddress: string) => {
  const sessions = useSessionKeyStore.getState().sessions
  return sessions[walletAddress.toLowerCase()]?.encryptedKey
})

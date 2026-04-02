import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface SessionKeyEntry {
  privateKey: `0x${string}`
  address: `0x${string}`
  ownerAddress?: string // wallet address that registered this session
  expiry: number        // unix timestamp (seconds)
  scopeBitmap: number   // uint8 — bits 0-5 for CAW..UNFOLLOW
  spendLimit?: string   // whole CAW tokens as string (for JSON serialization), 0 = unlimited
  spent?: string        // whole CAW tokens spent so far (tracked locally)
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
  recordSpend: (amount: bigint) => boolean
  getRemainingLimit: () => bigint | null
}

/** Helper: get the session for the current wallet from state */
function sessionForWallet(state: { sessions: Record<string, SessionKeyEntry>; activeWallet: string | null }): SessionKeyEntry | null {
  if (!state.activeWallet) return null
  return state.sessions[state.activeWallet] || null
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
        return session
      },

      getActiveSessionForAddress: (address: string) => {
        const state = get()
        if (!state.enabled) return null
        const session = state.sessions[address.toLowerCase()] || null
        if (!session) return null
        if (session.expiry < Date.now() / 1000) return null
        return session
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

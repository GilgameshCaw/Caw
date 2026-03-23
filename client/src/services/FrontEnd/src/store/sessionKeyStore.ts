import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface SessionKeyEntry {
  privateKey: `0x${string}`
  address: `0x${string}`
  expiry: number        // unix timestamp (seconds)
  scopeBitmap: number   // uint8 — bits 0-5 for CAW..UNFOLLOW
  spendLimit?: string   // whole CAW tokens as string (for JSON serialization), 0 = unlimited
  spent?: string        // whole CAW tokens spent so far (tracked locally)
}

interface SessionKeyState {
  /** The active session key (address-based, covers all tokens for this wallet) */
  session: SessionKeyEntry | null
  /** User preference: use session keys or sign every action with wallet */
  enabled: boolean
  /** Whether the user has been shown the Quick Sign prompt (after first stake) */
  hasSeenPrompt: boolean

  setSession: (entry: SessionKeyEntry) => void
  clearSession: () => void
  setEnabled: (enabled: boolean) => void
  setHasSeenPrompt: (seen: boolean) => void
  getActiveSession: () => SessionKeyEntry | null
  /** Record spending against the session. Returns false if limit would be exceeded. */
  recordSpend: (amount: bigint) => boolean
  /** Get remaining spend limit (returns null if unlimited) */
  getRemainingLimit: () => bigint | null
}

export const useSessionKeyStore = create<SessionKeyState>()(
  persist(
    (set, get) => ({
      session: null,
      enabled: false,
      hasSeenPrompt: false,

      setSession: (entry) => set({ session: { spent: '0', ...entry } }),

      clearSession: () => set({ session: null, enabled: false }),

      setEnabled: (enabled) => set({ enabled }),

      setHasSeenPrompt: (seen) => set({ hasSeenPrompt: seen }),

      getActiveSession: () => {
        const state = get()
        if (!state.enabled) return null
        if (!state.session) return null
        if (state.session.expiry < Date.now() / 1000) {
          // Expired — clean up
          state.clearSession()
          return null
        }
        return state.session
      },

      recordSpend: (amount: bigint) => {
        const state = get()
        if (!state.session) return false

        const limit = BigInt(state.session.spendLimit || '0')
        if (limit === 0n) {
          // Unlimited — always succeeds, still track for display
          const newSpent = BigInt(state.session.spent || '0') + amount
          set({ session: { ...state.session, spent: newSpent.toString() } })
          return true
        }

        const currentSpent = BigInt(state.session.spent || '0')
        const newSpent = currentSpent + amount
        if (newSpent > limit) {
          return false // Would exceed limit
        }

        set({ session: { ...state.session, spent: newSpent.toString() } })
        return true
      },

      getRemainingLimit: () => {
        const state = get()
        if (!state.session) return null

        const limit = BigInt(state.session.spendLimit || '0')
        if (limit === 0n) return null // Unlimited

        const spent = BigInt(state.session.spent || '0')
        const remaining = limit - spent
        return remaining > 0n ? remaining : 0n
      },
    }),
    { name: 'caw-session-keys' }
  )
)

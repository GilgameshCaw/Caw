import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface SessionKeyEntry {
  privateKey: `0x${string}`
  address: `0x${string}`
  expiry: number        // unix timestamp (seconds)
  scopeBitmap: number   // uint8 — bits 0-5 for CAW..UNFOLLOW
}

interface SessionKeyState {
  /** tokenId => ephemeral session key data */
  sessions: Record<number, SessionKeyEntry>
  /** User preference: use session keys or sign every action with wallet */
  enabled: boolean

  setSession: (tokenId: number, entry: SessionKeyEntry) => void
  clearSession: (tokenId: number) => void
  setEnabled: (enabled: boolean) => void
  getActiveSession: (tokenId: number) => SessionKeyEntry | null
}

export const useSessionKeyStore = create<SessionKeyState>()(
  persist(
    (set, get) => ({
      sessions: {},
      enabled: false,

      setSession: (tokenId, entry) =>
        set(s => ({ sessions: { ...s.sessions, [tokenId]: entry } })),

      clearSession: (tokenId) =>
        set(s => {
          const { [tokenId]: _, ...rest } = s.sessions
          return { sessions: rest }
        }),

      setEnabled: (enabled) => set({ enabled }),

      getActiveSession: (tokenId) => {
        const state = get()
        if (!state.enabled) return null
        const session = state.sessions[tokenId]
        if (!session) return null
        if (session.expiry < Date.now() / 1000) {
          // Expired — clean up
          state.clearSession(tokenId)
          return null
        }
        return session
      },
    }),
    { name: 'caw-session-keys' }
  )
)

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AuthSessionState {
  sessionToken: string | null
  authorizedTokenIds: number[]
  authorizedAddresses: string[]
  expiresAt: number | null

  setSession: (token: string, tokenIds: number[], addresses: string[], expiresAt: number) => void
  addAuthorization: (tokenIds: number[], addresses: string[]) => void
  clearSession: () => void
  isTokenAuthorized: (tokenId: number) => boolean
}

export const useAuthStore = create<AuthSessionState>()(
  persist(
    (set, get) => ({
      sessionToken: null,
      authorizedTokenIds: [],
      authorizedAddresses: [],
      expiresAt: null,

      setSession: (token, tokenIds, addresses, expiresAt) =>
        set({
          sessionToken: token,
          authorizedTokenIds: tokenIds,
          authorizedAddresses: addresses,
          expiresAt,
        }),

      addAuthorization: (tokenIds, addresses) =>
        set(state => {
          const newTokenIds = [...state.authorizedTokenIds]
          for (const id of tokenIds) {
            if (!newTokenIds.includes(id)) newTokenIds.push(id)
          }
          const newAddresses = [...state.authorizedAddresses]
          for (const addr of addresses) {
            const lower = addr.toLowerCase()
            if (!newAddresses.includes(lower)) newAddresses.push(lower)
          }
          return {
            authorizedTokenIds: newTokenIds,
            authorizedAddresses: newAddresses,
          }
        }),

      clearSession: () =>
        set({
          sessionToken: null,
          authorizedTokenIds: [],
          authorizedAddresses: [],
          expiresAt: null,
        }),

      isTokenAuthorized: (tokenId) => get().authorizedTokenIds.includes(tokenId),
    }),
    {
      name: 'caw-auth-session',
      // `sessionToken` is no longer persisted — the HttpOnly cookie carries
      // the real auth, and an XSS payload should NOT be able to read it from
      // localStorage. The derived state (authorizedTokenIds, addresses,
      // expiresAt) is non-secret UI hint state — fine to persist for instant
      // badge rendering on cold start. Audit fix 2026-05-14 (F1).
      partialize: (state) => ({
        authorizedTokenIds: state.authorizedTokenIds,
        authorizedAddresses: state.authorizedAddresses,
        expiresAt: state.expiresAt,
      }) as AuthSessionState,
    }
  )
)

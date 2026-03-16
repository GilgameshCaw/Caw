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
    }
  )
)

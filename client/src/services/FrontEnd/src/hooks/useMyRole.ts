import { useEffect } from 'react'
import { create } from 'zustand'
import { apiFetch } from '~/api/client'
import { useActiveToken } from '~/store/tokenDataStore'
import { useAuthStore } from '~/store/authStore'

type Role = 'USER' | 'MODERATOR' | 'ADMIN'

interface RoleState {
  role: Role
  actorTokenId: number | null
  loaded: boolean
  setRole: (role: Role, actorTokenId: number | null) => void
  reset: () => void
}

const useMyRoleStore = create<RoleState>((set) => ({
  role: 'USER',
  actorTokenId: null,
  loaded: false,
  setRole: (role, actorTokenId) => set({ role, actorTokenId, loaded: true }),
  reset: () => set({ role: 'USER', actorTokenId: null, loaded: false }),
}))

let inFlight: Promise<void> | null = null

/**
 * Fetches /api/me/role once per session and caches it in a Zustand
 * store. Refreshes when the active token changes (a different wallet
 * could have a different role tier).
 *
 * Returns { role, actorTokenId, isModerator, isAdmin, loaded }.
 * isModerator covers both MODERATOR and ADMIN — the question 'can this
 * user moderate?' is true for both.
 */
export function useMyRole() {
  const role = useMyRoleStore(s => s.role)
  const actorTokenId = useMyRoleStore(s => s.actorTokenId)
  const loaded = useMyRoleStore(s => s.loaded)
  const setRole = useMyRoleStore(s => s.setRole)
  const reset = useMyRoleStore(s => s.reset)
  const activeToken = useActiveToken()
  const tokenId = activeToken?.tokenId
  const isAuthorized = useAuthStore(s => tokenId ? s.isTokenAuthorized(tokenId) : false)

  useEffect(() => {
    if (!isAuthorized || !tokenId) {
      reset()
      return
    }
    if (inFlight) return
    inFlight = apiFetch<{ role: Role; actorTokenId: number | null }>('/api/me/role')
      .then(r => setRole(r.role, r.actorTokenId))
      .catch(() => setRole('USER', null))
      .finally(() => { inFlight = null })
  }, [tokenId, isAuthorized])

  return {
    role,
    actorTokenId,
    loaded,
    isModerator: role === 'MODERATOR' || role === 'ADMIN',
    isAdmin: role === 'ADMIN',
  }
}

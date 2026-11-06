// src/store/blockedUsersStore.ts
// Server-backed blocked users store
import { create } from 'zustand'
import { apiFetch } from '~/api/client'

interface BlockedUser {
  tokenId: number
  username: string
  blockedAt: string
  displayName?: string | null
  avatarUrl?: string | null
  image?: string | null
}

interface BlockedUsersState {
  blockedUsers: BlockedUser[]
  // The token blockedUsers belongs to. Blocks are per token on the server.
  loadedFor: number | null

  // Actions
  fetchBlocks: (userId: number) => Promise<void>
  resetBlocks: () => void
  blockUser: (blockerId: number, blockedId: number, username: string) => Promise<void>
  unblockUser: (blockerId: number, blockedId: number) => Promise<void>
  isBlocked: (tokenId: number) => boolean
  getBlockedUserIds: () => number[]
}

export const useBlockedUsersStore = create<BlockedUsersState>()(
  (set, get) => ({
    blockedUsers: [],
    loadedFor: null,

    resetBlocks: () => set({ loadedFor: null, blockedUsers: [] }),

    fetchBlocks: async (userId: number) => {
      if (get().loadedFor === userId) return
      // Claim immediately to prevent concurrent calls, and drop the previous
      // token's list so it isn't applied to this one.
      set({ loadedFor: userId, blockedUsers: [] })
      try {
        const data = await apiFetch<{ blockedUsers: BlockedUser[] }>(
          `/api/blocks?userId=${userId}`
        )
        // The active token may have changed while this was in flight.
        if (get().loadedFor !== userId) return
        set({ blockedUsers: data.blockedUsers })
      } catch (err) {
        console.error('[BlockedUsersStore] Failed to fetch blocks:', err)
        // loadedFor stays set so we don't keep retrying. Skip the migration:
        // with the server unreachable it would drop the legacy list unsent.
        return
      }

      // Migrate legacy localStorage blocks to server
      try {
        const legacy = localStorage.getItem('caw-blocked-users')
        if (legacy) {
          const parsed = JSON.parse(legacy)
          const legacyBlocks: { tokenId: number; username: string }[] =
            parsed?.state?.blockedUsers || []
          if (legacyBlocks.length > 0) {
            console.log(`[BlockedUsersStore] Migrating ${legacyBlocks.length} legacy blocks to server`)
            for (const b of legacyBlocks) {
              try {
                await apiFetch('/api/blocks', {
                  method: 'POST',
                  body: JSON.stringify({ blockerId: userId, blockedId: b.tokenId })
                })
              } catch { /* ignore individual migration failures */ }
            }
            localStorage.removeItem('caw-blocked-users')
            // Re-fetch to get the merged list
            const refreshed = await apiFetch<{ blockedUsers: BlockedUser[] }>(
              `/api/blocks?userId=${userId}`
            )
            if (get().loadedFor === userId) set({ blockedUsers: refreshed.blockedUsers })
          } else {
            localStorage.removeItem('caw-blocked-users')
          }
        }
      } catch {
        // Ignore migration errors
      }
    },

    blockUser: async (blockerId: number, blockedId: number, username: string) => {
      console.log(`[BlockedUsersStore] Blocking user: blocker=${blockerId}, blocked=${blockedId}, username=${username}`)

      // Optimistic update
      set((state) => {
        if (state.blockedUsers.some(u => u.tokenId === blockedId)) return state
        return {
          blockedUsers: [
            ...state.blockedUsers,
            { tokenId: blockedId, username, blockedAt: new Date().toISOString() }
          ]
        }
      })

      try {
        await apiFetch('/api/blocks', {
          method: 'POST',
          body: JSON.stringify({ blockerId, blockedId })
        })
        console.log(`[BlockedUsersStore] Successfully blocked user ${blockedId}`)
      } catch (err) {
        console.error('[BlockedUsersStore] Failed to block user:', err)
        // Revert optimistic update
        set((state) => ({
          blockedUsers: state.blockedUsers.filter(u => u.tokenId !== blockedId)
        }))
      }
    },

    unblockUser: async (blockerId: number, blockedId: number) => {
      // Save for rollback
      const prev = get().blockedUsers

      // Optimistic update
      set((state) => ({
        blockedUsers: state.blockedUsers.filter(u => u.tokenId !== blockedId)
      }))

      try {
        await apiFetch('/api/blocks', {
          method: 'DELETE',
          body: JSON.stringify({ blockerId, blockedId })
        })
      } catch (err) {
        console.error('[BlockedUsersStore] Failed to unblock user:', err)
        // Revert
        set({ blockedUsers: prev })
      }
    },

    isBlocked: (tokenId: number) => {
      return get().blockedUsers.some(u => u.tokenId === tokenId)
    },

    getBlockedUserIds: () => {
      return get().blockedUsers.map(u => u.tokenId)
    }
  })
)

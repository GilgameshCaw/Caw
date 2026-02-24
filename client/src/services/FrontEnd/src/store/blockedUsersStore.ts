// src/store/blockedUsersStore.ts
// Browser-level blocked users store using localStorage
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface BlockedUser {
  tokenId: number
  username: string
  blockedAt: number // timestamp
}

interface BlockedUsersState {
  blockedUsers: BlockedUser[]

  // Actions
  blockUser: (tokenId: number, username: string) => void
  unblockUser: (tokenId: number) => void
  isBlocked: (tokenId: number) => boolean
  getBlockedUserIds: () => number[]
}

export const useBlockedUsersStore = create<BlockedUsersState>()(
  persist(
    (set, get) => ({
      blockedUsers: [],

      blockUser: (tokenId: number, username: string) => {
        set((state) => {
          // Don't add duplicates
          if (state.blockedUsers.some(u => u.tokenId === tokenId)) {
            return state
          }
          return {
            blockedUsers: [
              ...state.blockedUsers,
              { tokenId, username, blockedAt: Date.now() }
            ]
          }
        })
      },

      unblockUser: (tokenId: number) => {
        set((state) => ({
          blockedUsers: state.blockedUsers.filter(u => u.tokenId !== tokenId)
        }))
      },

      isBlocked: (tokenId: number) => {
        return get().blockedUsers.some(u => u.tokenId === tokenId)
      },

      getBlockedUserIds: () => {
        return get().blockedUsers.map(u => u.tokenId)
      }
    }),
    {
      name: 'caw-blocked-users',
      version: 1,
    }
  )
)

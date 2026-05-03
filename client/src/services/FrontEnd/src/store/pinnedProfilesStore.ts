import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Per-browser preference: which profile tokenIds the user has pinned, and
 * when each was pinned. Drives ordering in the ProfileChooser dropdown
 * and the AccountSettings "All Usernames" list (most-recent pin first
 * within each wallet group).
 *
 * NOT synced across browsers / devices on purpose — different machines
 * will typically have different connected wallets, and the pin set is
 * about *this* machine's quick-access preference. No on-chain truth here.
 */
interface PinnedProfilesState {
  /** tokenId -> ISO timestamp string when it was pinned. */
  pinnedAt: Record<number, string>

  pin: (tokenId: number) => void
  unpin: (tokenId: number) => void
  togglePin: (tokenId: number) => void
  isPinned: (tokenId: number) => boolean
}

export const usePinnedProfilesStore = create<PinnedProfilesState>()(
  persist(
    (set, get) => ({
      pinnedAt: {},

      pin: (tokenId) => set(state => ({
        pinnedAt: { ...state.pinnedAt, [tokenId]: new Date().toISOString() }
      })),

      unpin: (tokenId) => set(state => {
        const { [tokenId]: _, ...rest } = state.pinnedAt
        return { pinnedAt: rest }
      }),

      togglePin: (tokenId) => {
        const isPinned = !!get().pinnedAt[tokenId]
        if (isPinned) get().unpin(tokenId)
        else get().pin(tokenId)
      },

      isPinned: (tokenId) => !!get().pinnedAt[tokenId],
    }),
    { name: 'caw-pinned-profiles' }
  )
)

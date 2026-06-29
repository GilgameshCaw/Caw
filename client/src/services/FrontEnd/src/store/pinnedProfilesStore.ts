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
  /** tokenId -> lowercase owner address, captured at pin time. Lets the token
   *  refresh (useTokenDataUpdate) keep a pinned profile FETCHED even when its
   *  owner isn't the active address — so a pin actually keeps the profile in the
   *  chooser, not just reorders it. */
  pinnedOwner: Record<number, string>

  pin: (tokenId: number, owner?: string) => void
  unpin: (tokenId: number) => void
  togglePin: (tokenId: number, owner?: string) => void
  isPinned: (tokenId: number) => boolean
}

export const usePinnedProfilesStore = create<PinnedProfilesState>()(
  persist(
    (set, get) => ({
      pinnedAt: {},
      pinnedOwner: {},

      pin: (tokenId, owner) => set(state => ({
        pinnedAt: { ...state.pinnedAt, [tokenId]: new Date().toISOString() },
        pinnedOwner: owner
          ? { ...state.pinnedOwner, [tokenId]: owner.toLowerCase() }
          : state.pinnedOwner,
      })),

      unpin: (tokenId) => set(state => {
        const { [tokenId]: _, ...restAt } = state.pinnedAt
        const { [tokenId]: __, ...restOwner } = state.pinnedOwner
        return { pinnedAt: restAt, pinnedOwner: restOwner }
      }),

      togglePin: (tokenId, owner) => {
        const isPinned = !!get().pinnedAt[tokenId]
        if (isPinned) get().unpin(tokenId)
        else get().pin(tokenId, owner)
      },

      isPinned: (tokenId) => !!get().pinnedAt[tokenId],
    }),
    { name: 'caw-pinned-profiles' }
  )
)

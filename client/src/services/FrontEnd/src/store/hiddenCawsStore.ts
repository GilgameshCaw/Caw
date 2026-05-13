import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Optimistic post-hide tracking. When a user deletes their own post, the
// on-chain hide action takes 5–60s to land in the indexer. Without this
// store, the post stays visible to the deleter for that whole window.
//
// Persisted because navigation between feed pages (Home → Profile → Home)
// would otherwise re-fetch and the deleted post would briefly reappear.
//
// Keyed by `${tokenId}:${cawonce}`. cawonce is per-tokenId (not globally
// unique), so keying by cawonce alone collides across users — viewer who
// hid their own cawonce=N would silently suppress every other user's
// post with the same cawonce. The on-chain hide action is also
// sender-scoped (handleHideAction matches userId+cawonce), so this
// matches the server-side semantics.
//
// 30-day TTL: the indexer's hide is permanent, so once it lands the post
// is filtered server-side and our optimistic entry becomes redundant.

interface HiddenCawEntry {
  tokenId: number
  cawonce: number
  hiddenAt: number
}

// Recaw-undo is sender-scoped: a viewer can unrecaw the same original from a
// different active token without the first viewer's undo leaking. Keyed by
// `${recawerTokenId}:${originalTokenId}:${originalCawonce}` to match the
// on-chain `hide:recaw:<originalTokenId>:<originalCawonce>` semantics
// (handleHideAction: deleteMany where userId=sender, originalCaw matches).
interface HiddenRecawEntry {
  recawerTokenId: number
  originalTokenId: number
  originalCawonce: number
  hiddenAt: number
}

interface HiddenCawsStore {
  hiddenCawonces: Record<string, HiddenCawEntry>
  hiddenRecaws: Record<string, HiddenRecawEntry>
  hideCaw: (tokenId: number, cawonce: number) => void
  hideRecaw: (recawerTokenId: number, originalTokenId: number, originalCawonce: number) => void
  isHidden: (tokenId: number | undefined | null, cawonce: number | undefined | null) => boolean
  isRecawHidden: (recawerTokenId: number | undefined | null, originalTokenId: number | undefined | null, originalCawonce: number | undefined | null) => boolean
  clear: () => void
}

const TTL_MS = 30 * 24 * 60 * 60 * 1000

const entryKey = (tokenId: number, cawonce: number) => `${tokenId}:${cawonce}`
const recawKey = (recawerTokenId: number, originalTokenId: number, originalCawonce: number) =>
  `${recawerTokenId}:${originalTokenId}:${originalCawonce}`

export const useHiddenCawsStore = create<HiddenCawsStore>()(
  persist(
    (set, get) => ({
      hiddenCawonces: {},
      hiddenRecaws: {},

      hideCaw: (tokenId, cawonce) => {
        if (!tokenId || !cawonce) return
        set((state) => ({
          hiddenCawonces: {
            ...state.hiddenCawonces,
            [entryKey(tokenId, cawonce)]: { tokenId, cawonce, hiddenAt: Date.now() },
          },
        }))
      },

      hideRecaw: (recawerTokenId, originalTokenId, originalCawonce) => {
        if (!recawerTokenId || !originalTokenId || !originalCawonce) return
        set((state) => ({
          hiddenRecaws: {
            ...state.hiddenRecaws,
            [recawKey(recawerTokenId, originalTokenId, originalCawonce)]: {
              recawerTokenId,
              originalTokenId,
              originalCawonce,
              hiddenAt: Date.now(),
            },
          },
        }))
      },

      isHidden: (tokenId, cawonce) => {
        if (tokenId == null || cawonce == null) return false
        const entry = get().hiddenCawonces[entryKey(Number(tokenId), Number(cawonce))]
        if (!entry) return false
        if (Date.now() - entry.hiddenAt > TTL_MS) return false
        return true
      },

      isRecawHidden: (recawerTokenId, originalTokenId, originalCawonce) => {
        if (recawerTokenId == null || originalTokenId == null || originalCawonce == null) return false
        const entry = get().hiddenRecaws[recawKey(Number(recawerTokenId), Number(originalTokenId), Number(originalCawonce))]
        if (!entry) return false
        if (Date.now() - entry.hiddenAt > TTL_MS) return false
        return true
      },

      clear: () => set({ hiddenCawonces: {}, hiddenRecaws: {} }),
    }),
    {
      name: 'caw:hidden-caws',
      // Bumped from implicit v0 → v1 when the key shape changed from
      // `cawonce` to `${tokenId}:${cawonce}`. Old entries can't be
      // re-keyed (the deleter's tokenId wasn't recorded), so we drop
      // them — the indexer-side hide is the source of truth and will
      // catch up on the next refetch.
      // v2 adds hiddenRecaws; nothing to migrate, just preserve hiddenCawonces.
      version: 2,
      migrate: (persisted: unknown, fromVersion: number) => {
        if (fromVersion < 1) return { hiddenCawonces: {}, hiddenRecaws: {} }
        const prior = (persisted as { hiddenCawonces?: Record<string, HiddenCawEntry> }) || {}
        return { hiddenCawonces: prior.hiddenCawonces || {}, hiddenRecaws: {} }
      },
    },
  ),
)

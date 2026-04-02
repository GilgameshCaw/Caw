import { create } from 'zustand'
import { apiFetch } from '~/api/client'

interface BookmarksState {
  // Set of bookmarked caw IDs for fast lookup (optimistic, synced with server)
  bookmarkedCawIds: Set<string>

  // Sync from server-provided data (called when caws are loaded with isBookmarked)
  markBookmarked: (cawId: string) => void
  markNotBookmarked: (cawId: string) => void

  // Add a bookmark (optimistic + API call)
  addBookmark: (cawId: string) => void

  // Remove a bookmark (optimistic + API call)
  removeBookmark: (cawId: string) => void

  // Toggle bookmark (optimistic + API call), returns new state
  toggleBookmark: (cawId: string) => boolean

  // Check if a caw is bookmarked (local only)
  isBookmarked: (cawId: string) => boolean
}

export const useBookmarksStore = create<BookmarksState>()((set, get) => ({
  bookmarkedCawIds: new Set(),

  markBookmarked: (cawId: string) => {
    set(state => {
      if (state.bookmarkedCawIds.has(cawId)) return state
      const next = new Set(state.bookmarkedCawIds)
      next.add(cawId)
      return { bookmarkedCawIds: next }
    })
  },

  markNotBookmarked: (cawId: string) => {
    set(state => {
      if (!state.bookmarkedCawIds.has(cawId)) return state
      const next = new Set(state.bookmarkedCawIds)
      next.delete(cawId)
      return { bookmarkedCawIds: next }
    })
  },

  addBookmark: (cawId: string) => {
    set(state => {
      const next = new Set(state.bookmarkedCawIds)
      next.add(cawId)
      return { bookmarkedCawIds: next }
    })
    apiFetch(`/api/bookmarks/${cawId}`, { method: 'POST' }).catch(() => {
      set(state => {
        const next = new Set(state.bookmarkedCawIds)
        next.delete(cawId)
        return { bookmarkedCawIds: next }
      })
    })
  },

  removeBookmark: (cawId: string) => {
    set(state => {
      const next = new Set(state.bookmarkedCawIds)
      next.delete(cawId)
      return { bookmarkedCawIds: next }
    })
    apiFetch(`/api/bookmarks/${cawId}`, { method: 'DELETE' }).catch(() => {
      set(state => {
        const next = new Set(state.bookmarkedCawIds)
        next.add(cawId)
        return { bookmarkedCawIds: next }
      })
    })
  },

  toggleBookmark: (cawId: string) => {
    const isCurrentlyBookmarked = get().bookmarkedCawIds.has(cawId)
    if (isCurrentlyBookmarked) {
      get().removeBookmark(cawId)
      return false
    } else {
      get().addBookmark(cawId)
      return true
    }
  },

  isBookmarked: (cawId: string) => {
    return get().bookmarkedCawIds.has(cawId)
  },
}))

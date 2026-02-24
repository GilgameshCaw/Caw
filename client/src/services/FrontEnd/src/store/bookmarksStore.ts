import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface BookmarksState {
  // Store bookmarked caw IDs as strings
  bookmarkedCawIds: string[]

  // Add a bookmark
  addBookmark: (cawId: string) => void

  // Remove a bookmark
  removeBookmark: (cawId: string) => void

  // Toggle bookmark
  toggleBookmark: (cawId: string) => boolean // returns new state

  // Check if a caw is bookmarked
  isBookmarked: (cawId: string) => boolean

  // Get all bookmarked caw IDs
  getBookmarkedIds: () => string[]

  // Clear all bookmarks
  clearAll: () => void
}

export const useBookmarksStore = create<BookmarksState>()(
  persist(
    (set, get) => ({
      bookmarkedCawIds: [],

      addBookmark: (cawId: string) => {
        set(state => {
          if (state.bookmarkedCawIds.includes(cawId)) {
            return state // Already bookmarked
          }
          return {
            bookmarkedCawIds: [cawId, ...state.bookmarkedCawIds] // Add to beginning (most recent first)
          }
        })
      },

      removeBookmark: (cawId: string) => {
        set(state => ({
          bookmarkedCawIds: state.bookmarkedCawIds.filter(id => id !== cawId)
        }))
      },

      toggleBookmark: (cawId: string) => {
        const isCurrentlyBookmarked = get().bookmarkedCawIds.includes(cawId)
        if (isCurrentlyBookmarked) {
          get().removeBookmark(cawId)
          return false
        } else {
          get().addBookmark(cawId)
          return true
        }
      },

      isBookmarked: (cawId: string) => {
        return get().bookmarkedCawIds.includes(cawId)
      },

      getBookmarkedIds: () => {
        return get().bookmarkedCawIds
      },

      clearAll: () => {
        set({ bookmarkedCawIds: [] })
      }
    }),
    {
      name: 'caw-bookmarks',
      version: 1
    }
  )
)

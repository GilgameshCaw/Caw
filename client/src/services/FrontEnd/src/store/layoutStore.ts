import { create } from 'zustand'

// Imperative override for MainLayout's hide-chrome rendering. Pages can
// flip this for transient states that don't fit the static
// `handle.hideSidebars` route metadata — e.g. /usernames/new shows a
// fullscreen "minting…" view mid-tx then reverts to chrome on success.
// Pages should clear the override on unmount.
interface LayoutState {
  hideChromeOverride: boolean
  setHideChromeOverride: (v: boolean) => void

  /** Mobile-only: hide bottom nav + compose FAB without killing headers/sidebars. */
  hideMobileNavOverride: boolean
  setHideMobileNavOverride: (v: boolean) => void
}

export const useLayoutStore = create<LayoutState>((set) => ({
  hideChromeOverride: false,
  setHideChromeOverride: (v) => set({ hideChromeOverride: v }),

  hideMobileNavOverride: false,
  setHideMobileNavOverride: (v) => set({ hideMobileNavOverride: v }),
}))

import { create } from 'zustand'

interface ComposeDraftState {
  hasInlineDraft: boolean
  setHasInlineDraft: (value: boolean) => void
}

export const useComposeDraftStore = create<ComposeDraftState>((set) => ({
  hasInlineDraft: false,
  setHasInlineDraft: (value) => set({ hasInlineDraft: value }),
}))

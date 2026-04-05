import { create } from 'zustand'

interface SignInModalState {
  isOpen: boolean
  message?: string
  show: (message?: string) => void
  close: () => void
}

export const useSignInModalStore = create<SignInModalState>((set) => ({
  isOpen: false,
  message: undefined,
  show: (message) => set({ isOpen: true, message }),
  close: () => set({ isOpen: false, message: undefined }),
}))

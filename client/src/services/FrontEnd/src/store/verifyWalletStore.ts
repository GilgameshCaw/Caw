import { create } from 'zustand'

interface VerifyWalletState {
  isOpen: boolean
  onSuccess: (() => void) | null
  show: (onSuccess?: () => void) => void
  close: () => void
}

export const useVerifyWalletStore = create<VerifyWalletState>((set) => ({
  isOpen: false,
  onSuccess: null,
  show: (onSuccess) => set({ isOpen: true, onSuccess: onSuccess || null }),
  close: () => set({ isOpen: false, onSuccess: null }),
}))

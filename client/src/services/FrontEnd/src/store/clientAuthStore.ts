import { create } from 'zustand'

interface ClientAuthState {
  isOpen: boolean
  tokenId?: number
  /** Callback to retry the action after successful auth */
  onSuccess?: () => void
  show: (tokenId: number, onSuccess?: () => void) => void
  close: () => void
}

export const useClientAuthStore = create<ClientAuthState>((set) => ({
  isOpen: false,
  tokenId: undefined,
  onSuccess: undefined,
  show: (tokenId, onSuccess) => set({ isOpen: true, tokenId, onSuccess }),
  close: () => set({ isOpen: false, tokenId: undefined, onSuccess: undefined }),
}))

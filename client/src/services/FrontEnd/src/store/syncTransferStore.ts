import { create } from 'zustand'

interface SyncTransferState {
  isOpen: boolean
  tokenId: number | null
  username: string | null
  show: (tokenId: number, username: string) => void
  close: () => void
}

export const useSyncTransferStore = create<SyncTransferState>((set) => ({
  isOpen: false,
  tokenId: null,
  username: null,
  show: (tokenId, username) => set({ isOpen: true, tokenId, username }),
  close: () => set({ isOpen: false, tokenId: null, username: null })
}))

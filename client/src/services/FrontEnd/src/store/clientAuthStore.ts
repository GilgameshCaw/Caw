import { create } from 'zustand'

interface ClientAuthState {
  isOpen: boolean
  tokenId?: number
  /** Callback to retry the action after successful auth */
  onSuccess?: () => void
  /** Callback when the user dismisses the modal without authenticating —
   *  callers must use this to unstick any pending state (e.g. a "submitting"
   *  button) so the UI doesn't get permanently disabled on cancel. */
  onCancel?: () => void
  show: (tokenId: number, onSuccess?: () => void, onCancel?: () => void) => void
  /** Mark auth as completed — fires onSuccess and clears state. */
  succeed: () => void
  /** Dismiss without authenticating — fires onCancel and clears state. */
  close: () => void
}

export const useClientAuthStore = create<ClientAuthState>((set, get) => ({
  isOpen: false,
  tokenId: undefined,
  onSuccess: undefined,
  onCancel: undefined,
  show: (tokenId, onSuccess, onCancel) => set({ isOpen: true, tokenId, onSuccess, onCancel }),
  succeed: () => {
    const cb = get().onSuccess
    set({ isOpen: false, tokenId: undefined, onSuccess: undefined, onCancel: undefined })
    cb?.()
  },
  close: () => {
    const cb = get().onCancel
    set({ isOpen: false, tokenId: undefined, onSuccess: undefined, onCancel: undefined })
    cb?.()
  },
}))

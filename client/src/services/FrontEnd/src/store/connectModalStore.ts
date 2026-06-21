import { create } from 'zustand'

/**
 * Thin bridge between the always-on WagmiProvider world and the lazily-mounted
 * RainbowKitProvider world.
 *
 * Problem: `useConnectModal` / `useAccountModal` (from @rainbow-me/rainbowkit)
 * can only be called inside a rendered <RainbowKitProvider>. That provider is
 * lazy-mounted, so callers outside the lazy boundary (hooks, layout, feed
 * items, etc.) can't call it directly.
 *
 * Solution: a zustand store with two sides:
 *
 *   Producer side (RainbowKitLayer.tsx):
 *     - After the lazy chunk loads and RainbowKitProvider mounts, an inner
 *       component calls `setOpenConnectModal(fn)` / `setOpenAccountModal(fn)`.
 *     - On unmount it resets them to null.
 *
 *   Consumer side (useConnectModalBridge / useAccountModalBridge):
 *     - Any caller that wants a modal calls `requestOpen('connect' | 'account')`.
 *     - If the layer is already mounted, the fn is non-null and fires immediately.
 *     - If not, `requestOpen()` sets `mountRequested = true`, which causes
 *       Web3Provider to render the lazy layer. Once it mounts and registers
 *       the opener, `pendingModal` drains the queued call.
 */
type PendingModal = 'connect' | 'account' | null

interface ConnectModalState {
  /** The real openers from RainbowKit, or null before the layer mounts. */
  openConnectModal: (() => void) | null
  openAccountModal: (() => void) | null
  /** True once the lazy layer has been requested (causes Web3Provider to render it). */
  mountRequested: boolean
  /** Which modal should open as soon as the layer mounts. */
  pendingModal: PendingModal

  setOpenConnectModal: (fn: (() => void) | null) => void
  setOpenAccountModal: (fn: (() => void) | null) => void
  /** Call from outside: triggers lazy mount + queues an open if needed. */
  requestOpen: (modal: 'connect' | 'account') => void
  /** Called by the lazy layer after it registers the openers — drains pendingModal. */
  drainPendingOpen: () => void
}

export const useConnectModalStore = create<ConnectModalState>((set, get) => ({
  openConnectModal: null,
  openAccountModal: null,
  mountRequested: false,
  pendingModal: null,

  setOpenConnectModal: (fn) => set({ openConnectModal: fn }),
  setOpenAccountModal: (fn) => set({ openAccountModal: fn }),

  requestOpen: (modal) => {
    const { openConnectModal, openAccountModal } = get()
    const opener = modal === 'connect' ? openConnectModal : openAccountModal
    if (opener) {
      // Layer already mounted — open immediately.
      opener()
      return
    }
    // Layer not yet mounted — request it and queue the open.
    set({ mountRequested: true, pendingModal: modal })
  },

  drainPendingOpen: () => {
    const { openConnectModal, openAccountModal, pendingModal } = get()
    if (!pendingModal) return
    const opener = pendingModal === 'connect' ? openConnectModal : openAccountModal
    // Clear pendingModal UNCONDITIONALLY before calling opener.
    // If opener is null (layer just mounted but wallet already connected so
    // RainbowKit returns undefined), we still clear — leaving pendingModal set
    // would cause it to re-fire on the next unrelated state change (e.g. user
    // disconnects → opener becomes non-null → drainPendingOpen re-runs via the
    // ModalRegistrar effect → ghost modal opens without user action).
    set({ pendingModal: null })
    opener?.()
  },
}))

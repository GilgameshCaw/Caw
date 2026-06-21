import { useCallback } from 'react'
import { useConnectModalStore } from '~/store/connectModalStore'

/**
 * Drop-in replacement for `useConnectModal` from @rainbow-me/rainbowkit.
 *
 * Returns `{ openConnectModal }` where `openConnectModal` is always a
 * function (never undefined). Calling it either:
 *   - Opens the RK modal immediately if the lazy RainbowKitLayer is mounted.
 *   - Requests the layer to mount and queues the open if it isn't yet.
 *
 * Usage (same API as useConnectModal):
 *   const { openConnectModal } = useConnectModalBridge()
 *   <button onClick={openConnectModal}>Connect Wallet</button>
 *
 * The actual RK modal won't appear for ~50–200ms on first call (chunk fetch
 * + mount) but that's imperceptible relative to the wallet UX that follows.
 * Subsequent calls are instant (layer stays mounted once first requested).
 */
export function useConnectModalBridge(): { openConnectModal: (() => void) | undefined } {
  const requestOpen = useConnectModalStore(s => s.requestOpen)

  const openConnectModal = useCallback(() => {
    requestOpen('connect')
  }, [requestOpen])

  return { openConnectModal }
}

/**
 * Bridge for the RainbowKit account modal (disconnect, address, balance).
 * Same lazy-mount semantics as useConnectModalBridge.
 */
export function useAccountModalBridge(): { openAccountModal: (() => void) | undefined } {
  const requestOpen = useConnectModalStore(s => s.requestOpen)

  const openAccountModal = useCallback(() => {
    requestOpen('account')
  }, [requestOpen])

  return { openAccountModal }
}

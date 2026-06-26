import { useCallback } from 'react'
import { useConnectModalStore } from '~/store/connectModalStore'
import { useWalletPopulation } from '~/hooks/useWalletPopulation'
import { useNavigate } from '~/utils/localizedRouter'

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
  const { population } = useWalletPopulation()
  const navigate = useNavigate()

  const openConnectModal = useCallback(() => {
    // SINGLE chokepoint: every openConnectModal() call in the app routes through
    // here. A Population-B (passkey) user has NO wagmi wallet — opening the wagmi
    // connect modal is wrong (and confusing) for them. Route to passkey sign-in
    // instead. This guards every call site (like/recaw/reply/tip/poll/post/etc.)
    // at once, so individual components don't each need a Pop-B branch.
    if (population === 'B') {
      navigate('/signin/passkey')
      return
    }
    requestOpen('connect')
  }, [requestOpen, population, navigate])

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

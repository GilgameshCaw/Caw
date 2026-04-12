import { useRef, useEffect, useCallback } from 'react'
import { useAccount, useSwitchChain, useChainId } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'

/**
 * Hook that ensures a wallet is connected and on the correct chain before
 * executing an action. If the wallet isn't connected, opens the connect modal
 * and auto-executes the action once connected. If on the wrong chain, switches
 * and then executes.
 *
 * Usage:
 *   const ensureWallet = useEnsureWallet()
 *   const handleClick = () => ensureWallet({ chainId: sepolia.id }, async () => {
 *     await doSomething()
 *   })
 */
export function useEnsureWallet() {
  const { isConnected } = useAccount()
  const chainId = useChainId()
  const { openConnectModal } = useConnectModal()
  const { switchChainAsync } = useSwitchChain()

  const pendingAction = useRef<{ chainId?: number; action: () => Promise<void> } | null>(null)
  const wasDisconnected = useRef(false)

  // Auto-execute pending action when wallet connects
  useEffect(() => {
    if (!isConnected || !wasDisconnected.current || !pendingAction.current) return
    wasDisconnected.current = false

    const { chainId: targetChain, action } = pendingAction.current
    pendingAction.current = null

    const run = async () => {
      try {
        if (targetChain && chainId !== targetChain) {
          await switchChainAsync({ chainId: targetChain })
        }
        await action()
      } catch (err) {
        // User rejected switch or action failed — silently ignore
        console.warn('[useEnsureWallet] Deferred action failed:', err)
      }
    }
    run()
  }, [isConnected, chainId, switchChainAsync])

  /**
   * Ensure wallet is connected (and optionally on the right chain), then run the action.
   * @param opts.chainId - Target chain ID (optional — skip chain check if omitted)
   * @param action - Async function to execute once wallet is ready
   */
  return useCallback(
    async (opts: { chainId?: number } | null, action: () => Promise<void>) => {
      const targetChain = opts?.chainId

      // Not connected — store action and open modal
      if (!isConnected) {
        wasDisconnected.current = true
        pendingAction.current = { chainId: targetChain, action }
        openConnectModal?.()
        return
      }

      // Wrong chain — switch then execute
      if (targetChain && chainId !== targetChain) {
        try {
          await switchChainAsync({ chainId: targetChain })
        } catch {
          return // User rejected chain switch
        }
      }

      // Execute the action
      await action()
    },
    [isConnected, chainId, openConnectModal, switchChainAsync]
  )
}

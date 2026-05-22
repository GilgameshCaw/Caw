/**
 * useEthBalancePoll
 *
 * Polls the L1 ETH balance of an arbitrary address every `intervalMs`
 * milliseconds using the public viem client (bypassing wagmi's
 * connector system — the onramp EOA has a private key but is not yet
 * a wagmi-connected wallet).
 *
 * Used by OnrampOnboarding to detect when Moonpay has delivered ETH
 * to the freshly-generated EOA so the flow can advance to /usernames/new.
 *
 * The hook starts polling immediately when `address` is provided and
 * stops when the component unmounts or `address` becomes undefined.
 *
 * @param address       The L1 EOA address to watch, or undefined to pause.
 * @param intervalMs    Poll interval in milliseconds (default 5000).
 * @returns             The current balance in wei (bigint) and a loading flag.
 */

import { useEffect, useRef, useState } from 'react'
import { createPublicClient, http } from 'viem'
import { sepolia } from 'wagmi/chains'

// Reuse the same RPC endpoint the rest of the FE uses for L1.
const L1_RPC =
  (import.meta.env.VITE_L1_RPC_URL_FRONTEND as string | undefined) ||
  (import.meta.env.VITE_L1_RPC_URL as string | undefined) ||
  (typeof window !== 'undefined'
    ? `${window.location.origin}/api/rpc/l1`
    : '/api/rpc/l1')

// Singleton client — no benefit in recreating it on every render.
const l1Client = createPublicClient({
  chain: sepolia,
  transport: http(L1_RPC, { retryCount: 2, retryDelay: 1_000 }),
})

export interface UseEthBalancePollResult {
  balance: bigint
  isLoading: boolean
}

export function useEthBalancePoll(
  address: `0x${string}` | undefined,
  intervalMs = 5_000
): UseEthBalancePollResult {
  const [balance, setBalance] = useState<bigint>(0n)
  const [isLoading, setIsLoading] = useState(false)
  // Stable ref so the interval callback always reads the latest address
  // without needing to be recreated every time `address` changes.
  const addressRef = useRef(address)
  const mountedRef = useRef(true)

  useEffect(() => {
    addressRef.current = address
  }, [address])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!address) {
      setBalance(0n)
      setIsLoading(false)
      return
    }

    setIsLoading(true)

    const poll = async () => {
      const target = addressRef.current
      if (!target) return
      try {
        const bal = await l1Client.getBalance({ address: target })
        if (mountedRef.current) {
          setBalance(bal)
          setIsLoading(false)
        }
      } catch {
        // Network errors are expected during early polling; stay in loading
        // state until we get a real response.
      }
    }

    // Fire immediately on mount / address change, then on the schedule.
    void poll()
    const id = window.setInterval(() => { void poll() }, intervalMs)

    return () => {
      window.clearInterval(id)
    }
  }, [address, intervalMs])

  return { balance, isLoading }
}

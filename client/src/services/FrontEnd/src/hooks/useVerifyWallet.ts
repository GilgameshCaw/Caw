import { useState } from 'react'
import { useSignMessage, useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAuthStore } from '~/store/authStore'
import { apiFetch, retryOnIndexing } from '~/api/client'

export function useVerifyWallet() {
  const { sessionToken, setSession, addAuthorization } = useAuthStore()
  const { signMessageAsync } = useSignMessage()
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const [isVerifying, setIsVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const verify = async (): Promise<boolean> => {
    if (!isConnected) {
      openConnectModal?.()
      return false
    }

    setIsVerifying(true)
    setError(null)

    try {
      const timestamp = Math.floor(Date.now() / 1000)
      const message = `Verify wallet ownership for CAW\nTimestamp: ${timestamp}`

      const signature = await signMessageAsync({ message })

      // Tier 3 of the "RPC out of API request handlers" refactor: the API
      // returns 202 when the wallet's tokens haven't been indexed yet
      // (fresh transfer, indexer still catching up). retryOnIndexing
      // backs off and retries; on the final empty pass it surfaces the
      // last IndexingError as a normal failure.
      const data = await retryOnIndexing(() =>
        apiFetch<{
          sessionToken: string
          authorizedTokenIds: number[]
          authorizedAddresses: string[]
          expiresAt: number
        }>('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, signature }),
        })
      )

      if (sessionToken && data.sessionToken === sessionToken) {
        addAuthorization(data.authorizedTokenIds, data.authorizedAddresses)
      } else {
        setSession(
          data.sessionToken,
          data.authorizedTokenIds,
          data.authorizedAddresses,
          data.expiresAt
        )
      }
      return true
    } catch (err: any) {
      if (err?.name === 'UserRejectedRequestError' || err?.code === 4001) {
        setError('Signature rejected')
      } else {
        setError(err.message || 'Verification failed')
      }
      return false
    } finally {
      setIsVerifying(false)
    }
  }

  return { verify, isVerifying, error }
}

import { useState } from 'react'
import { useSignMessage, useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAuthStore } from '~/store/authStore'
import { API_HOST } from '~/api/client'

export function useVerifyWallet() {
  const { sessionToken, setSession, addAuthorization } = useAuthStore()
  const { signMessageAsync } = useSignMessage()
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const [isVerifying, setIsVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const verify = async () => {
    if (!isConnected) {
      openConnectModal?.()
      return
    }

    setIsVerifying(true)
    setError(null)

    try {
      const timestamp = Math.floor(Date.now() / 1000)
      const message = `Verify wallet ownership for CAW\nTimestamp: ${timestamp}`

      const signature = await signMessageAsync({ message })

      const res = await fetch(`${API_HOST}/api/auth/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(sessionToken ? { 'x-session-token': sessionToken } : {}),
        },
        body: JSON.stringify({ message, signature }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Verification failed')
      }

      const data = await res.json()

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
    } catch (err: any) {
      if (err?.name === 'UserRejectedRequestError' || err?.code === 4001) {
        setError('Signature rejected')
      } else {
        setError(err.message || 'Verification failed')
      }
    } finally {
      setIsVerifying(false)
    }
  }

  return { verify, isVerifying, error }
}

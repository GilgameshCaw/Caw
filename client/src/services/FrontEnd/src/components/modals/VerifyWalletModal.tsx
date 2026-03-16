import React, { useState } from 'react'
import { useSignMessage, useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useVerifyWalletStore } from '~/store/verifyWalletStore'
import { useAuthStore } from '~/store/authStore'
import { API_HOST } from '~/api/client'

const VerifyWalletModal: React.FC = () => {
  const { isDark } = useTheme()
  const { isOpen, onSuccess, close } = useVerifyWalletStore()
  const { sessionToken, setSession, addAuthorization } = useAuthStore()
  const { signMessageAsync } = useSignMessage()
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const [isVerifying, setIsVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleVerify = async () => {
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

      close()
      onSuccess?.()
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

  return (
    <ModalWrapper isOpen={isOpen} onClose={close} usePortal zIndex={9999}>
      <div className="p-6">
        <h2 className={`text-lg font-bold mb-3 ${isDark ? 'text-white' : 'text-gray-900'}`}>
          Verify Wallet Ownership
        </h2>
        <p className={`text-sm mb-6 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
          To perform this action, please verify you own this wallet by signing a message.
          This is free and does not create a transaction.
        </p>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-red-500 text-sm">
            {error}
          </div>
        )}

        <div className="flex gap-3 justify-end">
          <button
            onClick={close}
            className={`px-4 py-2 rounded-lg text-sm transition ${
              isDark
                ? 'bg-white/10 hover:bg-white/20 text-white'
                : 'bg-gray-100 hover:bg-gray-200 text-gray-900'
            }`}
          >
            Cancel
          </button>
          <button
            onClick={handleVerify}
            disabled={isVerifying}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              isVerifying
                ? 'opacity-50 cursor-not-allowed'
                : 'hover:opacity-90'
            } bg-yellow-500 text-black`}
          >
            {isVerifying ? 'Signing...' : isConnected ? 'Verify' : 'Connect Wallet'}
          </button>
        </div>
      </div>
    </ModalWrapper>
  )
}

export default VerifyWalletModal

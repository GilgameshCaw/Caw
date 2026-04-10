import React, { useState, useEffect, useCallback } from 'react'
import { useSignMessage, useAccount } from 'wagmi'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import {
  decryptPrivateKey,
  getEncryptionSignMessage,
  setDecryptedKey,
  requestKeyFromOtherTabs,
} from '~/services/sessionKeyEncryption'
import { HiLockClosed } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'

/**
 * Shown when the active session is encrypted and needs unlocking.
 * Tries to get the key from another tab first; if not, prompts a wallet signature.
 */
const QuickSignUnlock: React.FC = () => {
  const needsUnlock = useSessionKeyStore(s => s.needsUnlock())
  const activeWallet = useSessionKeyStore(s => s.activeWallet)
  const sessions = useSessionKeyStore(s => s.sessions)
  const { signMessageAsync } = useSignMessage()
  const { isConnected } = useAccount()
  const { isDark } = useTheme()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [triedOtherTabs, setTriedOtherTabs] = useState(false)

  // On mount, try to get the key from another tab
  useEffect(() => {
    if (!needsUnlock || !activeWallet || triedOtherTabs) return
    setTriedOtherTabs(true)
    requestKeyFromOtherTabs(activeWallet).then(key => {
      if (key) {
        setDecryptedKey(activeWallet, key)
        // Force store re-render
        useSessionKeyStore.setState({})
      }
    })
  }, [needsUnlock, activeWallet, triedOtherTabs])

  const handleUnlock = useCallback(async () => {
    if (!activeWallet) return
    const session = sessions[activeWallet]
    if (!session?.encryptedKey) return

    setLoading(true)
    setError(null)
    try {
      const walletSig = await signMessageAsync({ message: getEncryptionSignMessage() })
      const privateKey = await decryptPrivateKey(session.encryptedKey, walletSig)
      setDecryptedKey(activeWallet, privateKey)
      // Force store re-render
      useSessionKeyStore.setState({})
    } catch (err: any) {
      const msg = err?.message || ''
      if (msg.includes('rejected') || msg.includes('denied') || err?.code === 4001) {
        setError('Signature cancelled.')
      } else {
        setError('Failed to decrypt. Try again.')
      }
    } finally {
      setLoading(false)
    }
  }, [activeWallet, sessions, signMessageAsync])

  if (!needsUnlock || !isConnected) return null

  return (
    <div className={`fixed bottom-4 right-4 z-50 max-w-sm rounded-xl shadow-lg border p-4 ${
      isDark
        ? 'bg-gray-900 border-yellow-700/50'
        : 'bg-white border-yellow-300'
    }`}>
      <div className="flex items-center gap-3 mb-2">
        <HiLockClosed className="w-5 h-5 text-yellow-500 flex-shrink-0" />
        <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
          Quick Sign is locked
        </p>
      </div>
      <p className={`text-xs mb-3 ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
        Sign with your wallet to unlock Quick Sign for this session.
      </p>
      {error && (
        <p className="text-xs text-red-400 mb-2">{error}</p>
      )}
      <button
        onClick={handleUnlock}
        disabled={loading}
        className="w-full py-2 rounded-lg text-sm font-medium bg-yellow-500 hover:bg-yellow-600 text-black transition-colors disabled:opacity-50 cursor-pointer"
      >
        {loading ? 'Signing...' : 'Unlock'}
      </button>
    </div>
  )
}

export default QuickSignUnlock

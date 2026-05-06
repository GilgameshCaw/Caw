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
import { useT } from '~/i18n/I18nProvider'

/**
 * Shown when the active session is encrypted and needs unlocking.
 * Tries to get the key from another tab first; if not, prompts a wallet signature.
 */
const QuickSignUnlock: React.FC = () => {
  const needsUnlock = useSessionKeyStore(s => s.needsUnlock())
  const activeWallet = useSessionKeyStore(s => s.activeWallet)
  const sessions = useSessionKeyStore(s => s.sessions)
  const { signMessageAsync } = useSignMessage()
  const { isConnected, address: connectedAddress } = useAccount()
  const { isDark } = useTheme()
  const t = useT()
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
    // Refuse to ask for the unlock signature if the wallet is currently
    // connected as a different account than the one that encrypted the
    // session — the resulting signature would be derived from the wrong
    // wallet and decryption would silently fail with a generic error.
    if (connectedAddress && connectedAddress.toLowerCase() !== activeWallet.toLowerCase()) {
      setError(
        `Wrong wallet connected. Switch to ${activeWallet.slice(0, 6)}…${activeWallet.slice(-4)} in your wallet to unlock.`
      )
      setLoading(false)
      return
    }
    try {
      const walletSig = await signMessageAsync({ message: getEncryptionSignMessage() })
      const privateKey = await decryptPrivateKey(session.encryptedKey, walletSig)
      setDecryptedKey(activeWallet, privateKey)
      // Force store re-render
      useSessionKeyStore.setState({})
    } catch (err: any) {
      const msg = err?.message || ''
      if (msg.includes('rejected') || msg.includes('denied') || err?.code === 4001) {
        setError(t('quick_sign_unlock.error.cancelled'))
      } else {
        setError(t('quick_sign_unlock.error.decrypt'))
      }
    } finally {
      setLoading(false)
    }
  }, [activeWallet, sessions, signMessageAsync, connectedAddress])

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
          {t('quick_sign_unlock.title')}
        </p>
      </div>
      <p className={`text-xs mb-3 ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
        {t('quick_sign_unlock.body')}
      </p>
      {error && (
        <p className="text-xs text-red-400 mb-2">{error}</p>
      )}
      <button
        onClick={handleUnlock}
        disabled={loading}
        className="w-full py-2 rounded-lg text-sm font-medium bg-yellow-500 hover:bg-yellow-600 text-black transition-colors disabled:opacity-50 cursor-pointer"
      >
        {loading ? t('quick_sign_unlock.btn.signing') : t('quick_sign_unlock.btn.unlock')}
      </button>
    </div>
  )
}

export default QuickSignUnlock

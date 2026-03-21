import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { useAuthStore } from '~/store/authStore'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { clearKeyCache } from '~/services/DmCryptoService'
import { useAccount } from 'wagmi'
import { HiArrowLeft, HiClipboard, HiCheck, HiExternalLink, HiCurrencyDollar, HiUser, HiIdentification, HiKey, HiExclamation } from 'react-icons/hi'
import { formatCAWAmount } from '~/utils/numberFormat'
import ModalWrapper from '~/components/modals/ModalWrapper'
import Tooltip from '~/components/Tooltip'

const AccountSettings: React.FC = () => {
  const { isDark } = useTheme()
  const { address, isConnected } = useAccount()
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [showClearDataModal, setShowClearDataModal] = useState(false)

  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const tokensByAddress = useTokenDataStore(s => s.tokensByAddress)

  // Get active token data
  const activeToken = Object.values(tokensByAddress).flat().find(t => t.tokenId === activeTokenId)

  // Get all tokens — if wallet is connected use that address, otherwise show all known tokens
  const allTokens = address
    ? tokensByAddress[address.toLowerCase()] || []
    : Object.values(tokensByAddress).flat()

  const handleClearAllData = () => {
    // Clear Zustand persisted stores
    useTokenDataStore.getState().removeActiveToken?.()
    useAuthStore.getState().clearSession()
    // Clear all session keys
    const sessionState = useSessionKeyStore.getState()
    Object.keys(sessionState.sessions).forEach(tokenId => {
      sessionState.clearSession(Number(tokenId))
    })
    // Clear DM key cache
    clearKeyCache()
    // Clear all CAW-related localStorage keys
    const keysToRemove = [
      'caw-token-data', 'caw-auth-session', 'caw-session-keys',
      'mutedThreads', 'mutedWords', 'hiddenPosts', 'mutedAccounts',
      'blockedAccounts', 'reportedPosts', 'notificationPreferences',
      'lastStakeTime', 'hideMuteConfirmModal'
    ]
    keysToRemove.forEach(key => localStorage.removeItem(key))
    setShowClearDataModal(false)
    // Reload to reset all in-memory state
    window.location.reload()
  }

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text)
    setCopiedField(field)
    setTimeout(() => setCopiedField(null), 2000)
  }

  const truncateAddress = (addr: string) => {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`
  }

  const InfoRow: React.FC<{
    icon: React.ReactNode
    label: string
    value: string
    copyable?: boolean
    copyValue?: string
    link?: string
  }> = ({ icon, label, value, copyable, copyValue, link }) => (
    <div className={`flex items-center justify-between py-4 border-b ${
      isDark ? 'border-white/10' : 'border-gray-100'
    }`}>
      <div className="flex items-center gap-3">
        <div className={isDark ? 'text-white/60' : 'text-gray-500'}>
          {icon}
        </div>
        <div>
          <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
            {label}
          </p>
          <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {value}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {copyable && (
          <Tooltip text="Copy to clipboard">
            <button
              onClick={() => copyToClipboard(copyValue || value, label)}
              className={`p-2 rounded-lg transition-colors ${
                isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
              }`}
            >
              {copiedField === label ? (
                <HiCheck className="w-5 h-5 text-green-500" />
              ) : (
                <HiClipboard className={`w-5 h-5 ${isDark ? 'text-white/60' : 'text-gray-500'}`} />
              )}
            </button>
          </Tooltip>
        )}
        {link && (
          <Tooltip text="View on explorer">
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className={`p-2 rounded-lg transition-colors ${
                isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
              }`}
            >
              <HiExternalLink className={`w-5 h-5 ${isDark ? 'text-white/60' : 'text-gray-500'}`} />
            </a>
          </Tooltip>
        )}
      </div>
    </div>
  )

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <Link
            to="/settings"
            className={`p-2 rounded-full transition-colors cursor-pointer ${
              isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
            }`}
          >
            <HiArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              Account
            </h1>
            <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
              View your account details
            </p>
          </div>
        </div>

        {/* Wallet Section */}
        {isConnected && address && (
          <section className="mb-8">
            <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${
              isDark ? 'text-white/40' : 'text-gray-400'
            }`}>
              Wallet
            </h2>

            <InfoRow
              icon={<HiKey className="w-5 h-5" />}
              label="Address"
              value={truncateAddress(address)}
              copyable
              copyValue={address}
              link={`https://etherscan.io/address/${address}`}
            />
          </section>
        )}

        {/* Active Username Section */}
        {activeToken && (
          <section className="mb-8">
            <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${
              isDark ? 'text-white/40' : 'text-gray-400'
            }`}>
              Active Username
            </h2>

            <InfoRow
              icon={<HiUser className="w-5 h-5" />}
              label="Username"
              value={`@${activeToken.username}`}
            />

            <InfoRow
              icon={<HiIdentification className="w-5 h-5" />}
              label="Token ID"
              value={`#${activeToken.tokenId}`}
            />

            <InfoRow
              icon={<HiCurrencyDollar className="w-5 h-5" />}
              label="Staked CAW"
              value={formatCAWAmount(activeToken.stakedAmount || '0')}
            />
          </section>
        )}

        {/* All Usernames Section */}
        {allTokens.length > 1 && (
          <section className="mb-8">
            <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${
              isDark ? 'text-white/40' : 'text-gray-400'
            }`}>
              All Usernames ({allTokens.length})
            </h2>

            <div className="space-y-2">
              {allTokens.map(token => (
                <div
                  key={token.tokenId}
                  className={`flex items-center justify-between p-4 rounded-lg ${
                    token.tokenId === activeTokenId
                      ? isDark ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-yellow-50 border border-yellow-200'
                      : isDark ? 'bg-white/5' : 'bg-gray-50'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <img
                      src={token.avatarUrl || token.image || '/images/logo.jpeg'}
                      alt={token.username}
                      className="w-10 h-10 rounded-full"
                    />
                    <div>
                      <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                        @{token.username}
                      </p>
                      <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                        Token #{token.tokenId}
                      </p>
                    </div>
                  </div>
                  {token.tokenId === activeTokenId && (
                    <span className={`text-xs px-2 py-1 rounded-full ${
                      isDark ? 'bg-yellow-500/20 text-yellow-500' : 'bg-yellow-100 text-yellow-700'
                    }`}>
                      Active
                    </span>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Contract Info */}
        <section className="mb-8">
          <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${
            isDark ? 'text-white/40' : 'text-gray-400'
          }`}>
            Contract Info
          </h2>

          <div className={`p-4 rounded-lg ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
            <div className="flex items-center justify-between mb-3">
              <span className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                CAW Token
              </span>
              <a
                href="https://etherscan.io/token/0xf3b9569F82B18aEf890De263B84189bd33EBe452"
                target="_blank"
                rel="noopener noreferrer"
                className={`text-sm flex items-center gap-1 ${
                  isDark ? 'text-yellow-500 hover:text-yellow-400' : 'text-yellow-600 hover:text-yellow-700'
                }`}
              >
                0xf3b9...e452
                <HiExternalLink className="w-4 h-4" />
              </a>
            </div>
            <p className={`text-xs ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
              CAW is deployed on Ethereum mainnet. Username NFTs are on L2 networks.
            </p>
          </div>
        </section>

        {/* Manage Profile Link */}
        {activeToken && (
          <Link
            to={`/users/${activeToken.username}`}
            className={`flex items-center justify-between py-4 px-4 rounded-lg transition-colors ${
              isDark ? 'bg-white/5 hover:bg-white/10' : 'bg-gray-50 hover:bg-gray-100'
            }`}
          >
            <div>
              <h3 className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                View Profile
              </h3>
              <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                See your public profile page
              </p>
            </div>
            <svg
              className={`w-5 h-5 ${isDark ? 'text-white/40' : 'text-gray-400'}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        )}

        {/* Clear Browser Data */}
        <section className="mt-12 mb-8">
          <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${
            isDark ? 'text-white/40' : 'text-gray-400'
          }`}>
            Browser Data
          </h2>
          <button
            onClick={() => setShowClearDataModal(true)}
            className={`w-full flex items-center justify-between py-4 px-4 rounded-lg transition-colors cursor-pointer ${
              isDark ? 'bg-red-500/10 hover:bg-red-500/20' : 'bg-red-50 hover:bg-red-100'
            }`}
          >
            <div className="text-left">
              <h3 className={`font-medium ${isDark ? 'text-red-400' : 'text-red-600'}`}>
                Clear All Browser Data
              </h3>
              <p className={`text-sm ${isDark ? 'text-red-400/60' : 'text-red-500/70'}`}>
                Remove all locally stored data and reset the app
              </p>
            </div>
            <HiExclamation className={`w-5 h-5 ${isDark ? 'text-red-400' : 'text-red-500'}`} />
          </button>
        </section>

        {/* Clear Data Confirmation Modal */}
        <ModalWrapper isOpen={showClearDataModal} onClose={() => setShowClearDataModal(false)} maxWidth="max-w-sm">
          <div className="p-5 space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-full bg-red-500/20">
                <HiExclamation className="w-5 h-5 text-red-500" />
              </div>
              <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Clear All Browser Data?
              </h3>
            </div>

            <p className={`text-sm ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
              This will permanently remove all locally stored data from this browser. This action cannot be undone.
            </p>

            <div className={`text-sm space-y-2 p-3 rounded-lg ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
              <p className={`font-medium mb-2 ${isDark ? 'text-white/80' : 'text-gray-700'}`}>This will:</p>
              <ul className={`space-y-1.5 ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                <li className="flex items-start gap-2">
                  <span className="text-red-400 mt-0.5">•</span>
                  Revoke Quick Sign session keys
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-red-400 mt-0.5">•</span>
                  Disable DMs (you'll need to re-enable)
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-red-400 mt-0.5">•</span>
                  Remove all attached wallet data
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-red-400 mt-0.5">•</span>
                  Clear muted/blocked accounts and hidden posts
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-red-400 mt-0.5">•</span>
                  Reset notification preferences
                </li>
              </ul>
            </div>

            <p className={`text-xs ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
              Your on-chain data (username, staked CAW, NFTs) is not affected.
            </p>

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setShowClearDataModal(false)}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                  isDark
                    ? 'bg-white/10 text-white hover:bg-white/20'
                    : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
                }`}
              >
                Cancel
              </button>
              <button
                onClick={handleClearAllData}
                className="flex-1 py-2.5 rounded-lg text-sm font-medium bg-red-500 text-white hover:bg-red-600 transition-colors cursor-pointer"
              >
                Clear Everything
              </button>
            </div>
          </div>
        </ModalWrapper>
      </div>
    </MainLayout>
  )
}

export default AccountSettings

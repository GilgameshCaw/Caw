import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { useAccount } from 'wagmi'
import { HiArrowLeft, HiClipboard, HiCheck, HiExternalLink, HiCurrencyDollar, HiUser, HiIdentification, HiKey } from 'react-icons/hi'
import { formatCAWAmount } from '~/utils/numberFormat'

const AccountSettings: React.FC = () => {
  const { isDark } = useTheme()
  const { address, isConnected } = useAccount()
  const [copiedField, setCopiedField] = useState<string | null>(null)

  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const tokensByAddress = useTokenDataStore(s => s.tokensByAddress)

  // Get active token data
  const activeToken = Object.values(tokensByAddress).flat().find(t => t.tokenId === activeTokenId)

  // Get all tokens for this wallet
  const allTokens = address ? tokensByAddress[address.toLowerCase()] || [] : []

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
          <button
            onClick={() => copyToClipboard(copyValue || value, label)}
            className={`p-2 rounded-lg transition-colors ${
              isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
            }`}
            title="Copy to clipboard"
          >
            {copiedField === label ? (
              <HiCheck className="w-5 h-5 text-green-500" />
            ) : (
              <HiClipboard className={`w-5 h-5 ${isDark ? 'text-white/60' : 'text-gray-500'}`} />
            )}
          </button>
        )}
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className={`p-2 rounded-lg transition-colors ${
              isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
            }`}
            title="View on explorer"
          >
            <HiExternalLink className={`w-5 h-5 ${isDark ? 'text-white/60' : 'text-gray-500'}`} />
          </a>
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

        {!isConnected ? (
          <div className={`text-center py-12 rounded-xl ${
            isDark ? 'bg-white/5' : 'bg-gray-50'
          }`}>
            <HiUser className={`w-12 h-12 mx-auto mb-4 ${isDark ? 'text-white/20' : 'text-gray-300'}`} />
            <p className={`text-lg font-medium mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
              Not Connected
            </p>
            <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
              Connect your wallet to view account details
            </p>
          </div>
        ) : (
          <>
            {/* Wallet Section */}
            <section className="mb-8">
              <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${
                isDark ? 'text-white/40' : 'text-gray-400'
              }`}>
                Wallet
              </h2>

              <InfoRow
                icon={<HiKey className="w-5 h-5" />}
                label="Address"
                value={address ? truncateAddress(address) : 'Not connected'}
                copyable={!!address}
                copyValue={address}
                link={address ? `https://etherscan.io/address/${address}` : undefined}
              />
            </section>

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
          </>
        )}
      </div>
    </MainLayout>
  )
}

export default AccountSettings

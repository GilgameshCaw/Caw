import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { useActiveToken } from '~/store/tokenDataStore'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { useCreateSession, useRevokeSession } from '~/hooks/useSessionKey'
import { HiArrowLeft } from 'react-icons/hi'

const SessionKeySettings: React.FC = () => {
  const { isDark } = useTheme()
  const activeToken = useActiveToken()
  const enabled = useSessionKeyStore(s => s.enabled)
  const setEnabled = useSessionKeyStore(s => s.setEnabled)
  const sessions = useSessionKeyStore(s => s.sessions)
  const createSession = useCreateSession()
  const revokeSession = useRevokeSession()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tokenId = activeToken?.tokenId
  const session = tokenId ? sessions[tokenId] : null
  const isExpired = session ? session.expiry < Date.now() / 1000 : true
  const isActive = session && !isExpired

  const handleToggle = () => {
    setEnabled(!enabled)
    setError(null)
  }

  const handleActivate = async () => {
    setLoading(true)
    setError(null)
    try {
      await createSession()
    } catch (err: any) {
      setError(err?.shortMessage || err?.message || 'Failed to create session')
    } finally {
      setLoading(false)
    }
  }

  const handleRevoke = async () => {
    setLoading(true)
    setError(null)
    try {
      await revokeSession()
    } catch (err: any) {
      setError(err?.shortMessage || err?.message || 'Failed to revoke session')
    } finally {
      setLoading(false)
    }
  }

  const formatExpiry = (timestamp: number) => {
    const date = new Date(timestamp * 1000)
    const now = Date.now()
    const remaining = timestamp * 1000 - now
    if (remaining <= 0) return 'Expired'

    const hours = Math.floor(remaining / (1000 * 60 * 60))
    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60))
    return `${hours}h ${minutes}m remaining (${date.toLocaleString()})`
  }

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4 bg-black">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <Link to="/settings" className={`p-2 rounded-full transition-colors ${
            isDark ? 'hover:bg-white/10 text-white' : 'hover:bg-gray-100 text-black'
          }`}>
            <HiArrowLeft className="w-5 h-5" />
          </Link>
          <h1 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>
            Quick Sign
          </h1>
        </div>

        {/* Toggle */}
        <div className={`flex items-center justify-between py-4 border-b ${
          isDark ? 'border-white/10' : 'border-gray-100'
        }`}>
          <div>
            <h3 className={`font-semibold ${isDark ? 'text-white' : 'text-black'}`}>
              Enable Quick Sign
            </h3>
            <p className={`text-sm mt-1 ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
              Sign once with your wallet, then post without popups for 72 hours
            </p>
          </div>
          <button
            onClick={handleToggle}
            className={`relative w-12 h-7 rounded-full transition-colors duration-200 ${
              enabled ? 'bg-blue-500' : isDark ? 'bg-gray-600' : 'bg-gray-300'
            }`}
          >
            <div className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform duration-200 ${
              enabled ? 'translate-x-5' : 'translate-x-0.5'
            }`} />
          </button>
        </div>

        {/* Security explanation */}
        {enabled && (
          <div className="mt-4 bg-yellow-900/20 border border-yellow-700/50 rounded-lg p-4 text-sm">
            <p className="font-medium text-yellow-400">How it works</p>
            <p className={`mt-2 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
              Quick Sign creates a temporary signing key stored in your browser.
              It can post, like, repost, and follow on your behalf — but it{' '}
              <strong>cannot withdraw tokens or transfer your name</strong>.
            </p>
            <ul className={`mt-2 space-y-1 list-disc list-inside ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
              <li>The key expires automatically after 72 hours</li>
              <li>You can revoke it at any time</li>
              <li>Transferring your name automatically invalidates it</li>
              <li>If someone accesses your browser, they could use this key until it expires</li>
            </ul>
          </div>
        )}

        {/* Session status */}
        {enabled && (
          <div className="mt-6">
            {isActive ? (
              <div className={`rounded-lg p-4 ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                      <span className={`font-medium ${isDark ? 'text-green-400' : 'text-green-600'}`}>
                        Active
                      </span>
                    </div>
                    <p className={`text-sm mt-1 ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                      {formatExpiry(session!.expiry)}
                    </p>
                    <p className={`text-xs mt-1 font-mono ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                      Key: {session!.address.slice(0, 8)}...{session!.address.slice(-6)}
                    </p>
                  </div>
                  <button
                    onClick={handleRevoke}
                    disabled={loading}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-red-400 hover:text-red-300 hover:bg-red-900/20 transition-colors disabled:opacity-50"
                  >
                    {loading ? 'Revoking...' : 'Revoke'}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                {!tokenId ? (
                  <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                    Connect your wallet and select a profile to activate Quick Sign.
                  </p>
                ) : (
                  <button
                    onClick={handleActivate}
                    disabled={loading}
                    className="w-full py-3 rounded-lg font-medium text-white bg-blue-500 hover:bg-blue-600 transition-colors disabled:opacity-50"
                  >
                    {loading ? 'Activating...' : 'Activate Quick Sign'}
                  </button>
                )}
                {session && isExpired && (
                  <p className={`text-sm mt-2 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
                    Your previous session has expired. Activate a new one above.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mt-4 p-3 rounded-lg bg-red-900/20 border border-red-700/50 text-sm text-red-400">
            {error}
          </div>
        )}
      </div>
    </MainLayout>
  )
}

export default SessionKeySettings

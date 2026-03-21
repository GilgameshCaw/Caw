import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useReadContract, useAccount, useConnections, useSwitchChain } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { useActiveToken } from '~/store/tokenDataStore'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { useCreateSession, useRevokeSession, DEFAULT_SPEND_LIMIT, DEFAULT_SESSION_DURATION } from '~/hooks/useSessionKey'
import { HiArrowLeft } from 'react-icons/hi'
import QuickSignOptions from '~/components/QuickSignOptions'
import { CAW_ACTIONS_ADDRESS } from '~/../../../abi/addresses'
import { cawActionsAbi } from '~/../../../abi/generated'
import { chains } from '~/config/chains'

const SessionKeySettings: React.FC = () => {
  const { isDark } = useTheme()
  const activeToken = useActiveToken()
  const enabled = useSessionKeyStore(s => s.enabled)
  const setEnabled = useSessionKeyStore(s => s.setEnabled)
  const session = useSessionKeyStore(s => s.session)
  const createSession = useCreateSession()
  const revokeSession = useRevokeSession()
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [spendLimit, setSpendLimit] = useState<bigint>(DEFAULT_SPEND_LIMIT)
  const [duration, setDuration] = useState<number>(DEFAULT_SESSION_DURATION)

  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const connections = useConnections()
  const { switchChain } = useSwitchChain()
  const wrongChain = isConnected && connections[0]?.chainId !== chains.l2.chainId
  const isExpired = session ? session.expiry < Date.now() / 1000 : true
  const isActive = session && !isExpired

  // Read on-chain spent amount for this session key
  const ownerAddress = address || activeToken?.address
  const { data: onChainSpent } = useReadContract({
    address: CAW_ACTIONS_ADDRESS,
    abi: cawActionsAbi,
    chainId: chains.l2.chainId,
    functionName: 'sessionSpent',
    args: [ownerAddress as `0x${string}`, session?.address!],
    query: { enabled: !!ownerAddress && !!session?.address && !!isActive }
  })

  // Sync on-chain spent back to local store for fast-check accuracy
  useEffect(() => {
    if (onChainSpent != null && session) {
      const store = useSessionKeyStore.getState()
      if (store.session) {
        store.setSession({ ...store.session, spent: onChainSpent.toString() })
      }
    }
  }, [onChainSpent, session?.address])

  const handleToggle = () => {
    setEnabled(!enabled)
    setError(null)
  }

  const handleActivate = async () => {
    if (!isConnected) {
      openConnectModal?.()
      return
    }
    if (wrongChain) {
      switchChain({ chainId: chains.l2.chainId })
      return
    }
    setLoading(true)
    setError(null)
    try {
      await createSession((s) => setStatus(s), spendLimit, duration)
    } catch (err: any) {
      const msg = err?.shortMessage || err?.message || 'Failed to create session'
      // Don't show "connect wallet" errors — the button handles that state
      if (!msg.toLowerCase().includes('connect your wallet')) {
        setError(msg)
      }
    } finally {
      setLoading(false)
      setStatus('')
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
    const remaining = timestamp * 1000 - Date.now()
    if (remaining <= 0) return 'Expired'

    const days = Math.floor(remaining / (1000 * 60 * 60 * 24))
    const hours = Math.floor((remaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
    if (days > 0) return `${days}d ${hours}h remaining`
    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60))
    return `${hours}h ${minutes}m remaining`
  }

  const formatSpendLimit = (limit?: string) => {
    if (!limit) return 'Unknown'
    const n = Number(limit)
    if (n === 0) return 'Unlimited'
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n % 1_000_000_000 === 0 ? 0 : 1)}B CAW`
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M CAW`
    if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K CAW`
    return `${n.toLocaleString()} CAW`
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
              Sign once with your wallet, then post without popups
            </p>
          </div>
          <button
            onClick={handleToggle}
            className={`relative w-12 h-7 rounded-full transition-colors duration-200 cursor-pointer ${
              enabled ? 'bg-yellow-500' : isDark ? 'bg-gray-600' : 'bg-gray-300'
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
            <p className={`mt-2 ${isDark ? 'text-gray-300' : 'text-gray-600'}`} style={{ marginBottom: 10 }}>
              Quick Sign creates a temporary signing key stored in your browser.
              It can post, like, repost, and follow on your behalf.
            </p>
            <p className={`${isDark ? 'text-gray-300' : 'text-gray-600'}`} style={{ marginBottom: 10 }}>
              It <strong>cannot withdraw tokens or transfer your name</strong>, but:
            </p>
            <ul className={`space-y-1 list-disc list-outside pl-5 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
              <li>Evil browser extensions with permission can access your staked CAW until key expiry or finished spending limit</li>
              <li>Transferring your name automatically invalidates it</li>
              <li>The key expires automatically after the chosen duration</li>
              <li>You can revoke it at any time</li>
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
                    <p className={`text-sm mt-1 ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                      Spend limit: {formatSpendLimit(session!.spendLimit)}
                      {session!.spendLimit && Number(session!.spendLimit) > 0 && (() => {
                        const limit = BigInt(session!.spendLimit || '0')
                        const spent = onChainSpent != null ? BigInt(onChainSpent) : BigInt(session!.spent || '0')
                        const remaining = limit - spent
                        return (
                          <span className={`ml-2 ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                            ({formatSpendLimit((remaining > 0n ? remaining : 0n).toString())} remaining)
                          </span>
                        )
                      })()}
                    </p>
                    <p className={`text-xs mt-1 font-mono ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                      Key: {session!.address.slice(0, 8)}...{session!.address.slice(-6)}
                    </p>
                  </div>
                  <button
                    onClick={handleRevoke}
                    disabled={loading}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-red-400 hover:text-red-300 hover:bg-red-900/20 transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    {loading ? 'Revoking...' : 'Revoke'}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                {!activeToken?.tokenId ? (
                  <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                    Connect your wallet and select a profile to activate Quick Sign.
                  </p>
                ) : (
                  <>
                    <div className="mb-5">
                      <QuickSignOptions
                        spendLimit={spendLimit}
                        onSpendLimitChange={setSpendLimit}
                        duration={duration}
                        onDurationChange={setDuration}
                        themed
                        isDark={isDark}
                      />
                    </div>

                    {error && (
                      <div className="mb-4 p-3 rounded-lg bg-red-900/20 border border-red-700/50 text-sm text-red-400">
                        {error}
                      </div>
                    )}

                    <div className="text-center">
                      <button
                        onClick={handleActivate}
                        disabled={loading}
                        className="px-6 py-3 rounded-lg font-medium bg-yellow-500 hover:bg-yellow-600 text-black transition-colors disabled:opacity-50 cursor-pointer"
                      >
                        {loading ? (status || 'Activating...') : !isConnected ? 'Connect Wallet' : wrongChain ? 'Switch Network' : 'Activate Quick Sign'}
                      </button>
                    </div>
                  </>
                )}
                {session && isExpired && (
                  <p className={`text-sm mt-3 text-center ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
                    Your previous session has expired. Activate a new one above.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </MainLayout>
  )
}

export default SessionKeySettings

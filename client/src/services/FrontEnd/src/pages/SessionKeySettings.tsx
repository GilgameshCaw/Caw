import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from '~/utils/localizedRouter'
import { useReadContract, useAccount, useConnections, useSwitchChain } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useActiveToken, usePriceStore } from '~/store/tokenDataStore'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { useCreateSession, useRevokeSession, getDefaultTipCeiling, DEFAULT_SPEND_LIMIT, DEFAULT_SESSION_DURATION } from '~/hooks/useSessionKey'
import { getTipTiers } from '~/api/actions'
import { HiArrowLeft } from 'react-icons/hi'
import QuickSignOptions from '~/components/QuickSignOptions'
import QuickSignHowItWorks from '~/components/QuickSignHowItWorks'
import { CAW_ACTIONS_ADDRESS } from '~/../../../abi/addresses'
import { cawActionsAbi } from '~/../../../abi/generated'
import { chains } from '~/config/chains'

const SessionKeySettings: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const ensureWallet = useEnsureWallet()
  const activeToken = useActiveToken()
  const enabled = useSessionKeyStore(s => s.enabled)
  const setEnabled = useSessionKeyStore(s => s.setEnabled)
  const sessions = useSessionKeyStore(s => s.sessions)
  const ownerAddr = activeToken?.owner?.toLowerCase()
  const session = (ownerAddr && sessions[ownerAddr]) || null
  const createSession = useCreateSession()
  // Keep a ref to the latest createSession so the action passed into
  // ensureWallet (which runs asynchronously after connect/chain-switch) always
  // calls the freshest closure — the one that sees isConnected=true and the
  // correct chainId. Without this, the deferred action calls a stale
  // createSession captured at click time (when isConnected was false), which
  // early-returns without prompting for the signature.
  const createSessionRef = useRef(createSession)
  useEffect(() => { createSessionRef.current = createSession }, [createSession])
  const revokeSession = useRevokeSession()
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  // Default to $10 worth of CAW. If price isn't loaded yet, fall back to a placeholder
  // and reactively update once the price arrives (see useEffect below).
  const defaultLimit = cawPrice > 0 ? BigInt(Math.round(10 / cawPrice)) : DEFAULT_SPEND_LIMIT
  const [spendLimit, setSpendLimit] = useState<bigint>(defaultLimit)
  const [spendLimitTouched, setSpendLimitTouched] = useState(false)
  const [duration, setDuration] = useState<number>(DEFAULT_SESSION_DURATION)
  const [tipCeiling, setTipCeiling] = useState<bigint>(() => getDefaultTipCeiling(getTipTiers().fast))
  const [walletProtect, setWalletProtect] = useState(false)

  // When CAW price loads (or changes), update the spend limit to ~$10 unless the user has
  // already manually picked a value.
  useEffect(() => {
    if (spendLimitTouched) return
    if (cawPrice > 0) {
      setSpendLimit(BigInt(Math.round(10 / cawPrice)))
    }
  }, [cawPrice, spendLimitTouched])

  // Wrap onSpendLimitChange so we mark "touched" when the user picks a preset
  const handleSpendLimitChange = useCallback((v: bigint) => {
    setSpendLimitTouched(true)
    setSpendLimit(v)
  }, [])

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
      const currentSession = ownerAddr ? store.getSessionForAddress(ownerAddr) : store.getSession()
      if (currentSession) {
        store.setSession({ ...currentSession, spent: onChainSpent.toString() })
      }
    }
  }, [onChainSpent, session?.address])

  const handleToggle = () => {
    setEnabled(!enabled)
    setError(null)
  }

  const handleActivate = async () => {
    await ensureWallet({ chainId: chains.l2.chainId }, async () => {
    setLoading(true)
    setError(null)
    try {
      // Call through the ref so we always get the freshest createSession
      // closure (post-connect, post-chain-switch). The function captured at
      // click time sees isConnected=false and would silently no-op.
      await createSessionRef.current((s) => setStatus(s), spendLimit, duration, walletProtect, tipCeiling)
    } catch (err: any) {
      console.error('[SessionKey] Create failed:', err)
      const msg = err?.message || ''
      if (msg.toLowerCase().includes('connect your wallet')) return
      const isUserRejection = msg.includes('rejected') || msg.includes('denied') || msg.includes('cancelled') || err?.code === 4001
      setError(isUserRejection ? t('quick_sign.error.cancelled') : (msg.includes('Please') || msg.includes('try again') ? msg : t('quick_sign.error.generic')))
    } finally {
      setLoading(false)
      setStatus('')
    }
    })
  }

  const handleRevoke = async () => {
    setLoading(true)
    setError(null)
    try {
      await revokeSession()
    } catch (err: any) {
      console.error('[SessionKey] Revoke failed:', err)
      setError(t('quick_sign.error.generic'))
    } finally {
      setLoading(false)
    }
  }

  const formatExpiry = (timestamp: number) => {
    const remaining = timestamp * 1000 - Date.now()
    if (remaining <= 0) return t('session_key.expired')

    const days = Math.floor(remaining / (1000 * 60 * 60 * 24))
    const hours = Math.floor((remaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
    if (days > 0) return t('session_key.days_hours_remaining', { days, hours })
    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60))
    return t('session_key.hours_minutes_remaining', { hours, minutes })
  }

  const formatSpendLimit = (limit?: string) => {
    if (!limit) return t('session_key.unknown')
    const n = Number(limit)
    if (n === 0) return t('session_key.unlimited')
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n % 1_000_000_000 === 0 ? 0 : 1)}B CAW`
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M CAW`
    if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K CAW`
    return `${n.toLocaleString()} CAW`
  }

  /** Convert a whole-CAW amount to a dollar string. Returns null if price is unknown or amount is 0. */
  const cawToUsd = (cawAmount?: string | bigint): string | null => {
    if (!cawAmount || cawPrice <= 0) return null
    const n = typeof cawAmount === 'bigint' ? Number(cawAmount) : Number(cawAmount)
    if (n === 0) return null
    const usd = n * cawPrice
    if (usd >= 1) return `$${usd.toFixed(2)}`
    if (usd >= 0.01) return `$${usd.toFixed(2)}`
    return `$${usd.toFixed(5)}` // tip-sized: show 5 decimals
  }

  return (
      <div className={`max-w-2xl mx-auto px-3 sm:px-6 py-4 ${isDark ? 'bg-black' : 'bg-white'}`}>
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <Link to="/settings" className={`p-2 rounded-full transition-colors ${
            isDark ? 'hover:bg-white/10 text-white' : 'hover:bg-gray-100 text-black'
          }`} aria-label={t('common.back')}>
            <HiArrowLeft className="w-5 h-5" />
          </Link>
          <h1 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>
            {t('session_key.page_title')}
          </h1>
        </div>

        {/* Toggle */}
        <div className={`flex items-center justify-between py-4 border-b ${
          isDark ? 'border-white/10' : 'border-gray-100'
        }`}>
          <div>
            <h2 className={`font-semibold ${isDark ? 'text-white' : 'text-black'}`}>
              {t('session_key.enable_heading')}
            </h2>
            <p className={`text-sm mt-1 ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
              {t('session_key.enable_subtitle')}
            </p>
          </div>
          <button
            onClick={handleToggle}
            role="switch"
            aria-checked={enabled}
            aria-label={t('session_key.enable_heading')}
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
          <div className="mt-4">
            <QuickSignHowItWorks isDark={isDark} />
          </div>
        )}

        {/* Session status */}
        {enabled && (
          <div className="mt-6">
            {isActive ? (
              <div className={`rounded-lg p-4 ${isDark ? 'bg-white/5' : 'bg-gray-50 shadow-xl'}`}>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                      <span className={`font-medium ${isDark ? 'text-green-400' : 'text-green-600'}`}>
                        {t('session_key.active')}
                      </span>
                    </div>
                    <p className={`text-sm mt-1 ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                      {formatExpiry(session!.expiry)}
                    </p>
                    <p className={`text-sm mt-1 ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                      {t('session_key.spend_limit')}: {formatSpendLimit(session!.spendLimit)}
                      {session!.spendLimit && Number(session!.spendLimit) > 0 && (() => {
                        const usd = cawToUsd(session!.spendLimit)
                        return usd ? (
                          <span className={`ml-1 ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                            (≈ {usd})
                          </span>
                        ) : null
                      })()}
                      {session!.spendLimit && Number(session!.spendLimit) > 0 && (() => {
                        const limit = BigInt(session!.spendLimit || '0')
                        const spent = onChainSpent != null ? BigInt(onChainSpent) : BigInt(session!.spent || '0')
                        const remaining = limit - spent
                        return (
                          <span className={`ml-2 ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                            ({t('session_key.amount_remaining', { amount: formatSpendLimit((remaining > 0n ? remaining : 0n).toString()) })})
                          </span>
                        )
                      })()}
                    </p>
                    {/* Validator tip cap */}
                    <p className={`text-sm mt-1 ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                      {t('session_key.tip_cap')}: {(() => {
                        if (session!.tipCeiling === undefined) return <span className="italic">{t('session_key.tip_legacy')}</span>
                        const ceiling = BigInt(session!.tipCeiling || '0')
                        if (ceiling === 0n) return <span className="text-yellow-500">{t('session_key.tip_optout')}</span>
                        const usd = cawToUsd(session!.tipCeiling)
                        return (
                          <>
                            {formatSpendLimit(session!.tipCeiling)}
                            {usd && <span className={`ml-1 ${isDark ? 'text-white/30' : 'text-gray-400'}`}>{t('session_key.tip_per_action', { usd })}</span>}
                          </>
                        )
                      })()}
                    </p>
                    {/* Wallet-protected indicator */}
                    <p className={`text-sm mt-1 ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                      {session!.encrypted
                        ? <>{t('session_key.wallet_unlock_label')} <span className="text-white">{t('session_key.wallet_unlock_required')}</span></>
                        : <>{t('session_key.wallet_unlock_label')} <span className={isDark ? 'text-white/70' : 'text-gray-700'}>{t('session_key.wallet_unlock_not_required')}</span></>
                      }
                    </p>
                    <p className={`text-xs mt-1 font-mono ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                      {t('session_key.key_label')}: {session!.address.slice(0, 8)}...{session!.address.slice(-6)}
                    </p>
                  </div>
                  <button
                    onClick={handleRevoke}
                    disabled={loading}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-red-400 hover:text-red-300 hover:bg-red-900/20 transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    {loading ? t('session_key.btn.revoking') : t('session_key.btn.revoke')}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                {!activeToken?.tokenId ? (
                  <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                    {t('session_key.connect_first')}
                  </p>
                ) : (
                  <>
                    <div className="mb-5">
                      <QuickSignOptions
                        spendLimit={spendLimit}
                        onSpendLimitChange={handleSpendLimitChange}
                        duration={duration}
                        onDurationChange={setDuration}
                        tipCeiling={tipCeiling}
                        onTipCeilingChange={setTipCeiling}
                        walletProtect={walletProtect}
                        onWalletProtectChange={setWalletProtect}
                        themed
                        isDark={isDark}
                      />
                    </div>

                    {error && (
                      <div className="mb-4 flex justify-center">
                        <div className="inline-block px-4 py-2 rounded-lg bg-red-900/20 border border-red-700/50 text-sm text-red-400 whitespace-pre-line">
                          {error}
                        </div>
                      </div>
                    )}

                    <div className="text-center">
                      {(() => {
                        const wrongWallet = isConnected && activeToken?.owner && address?.toLowerCase() !== activeToken.owner.toLowerCase()
                        return (
                          <>
                            <button
                              onClick={handleActivate}
                              disabled={loading || !!wrongWallet}
                              className="px-6 py-3 rounded-lg font-medium bg-yellow-500 hover:bg-yellow-600 text-black transition-colors disabled:opacity-50 disabled:hover:bg-yellow-500 cursor-pointer"
                            >
                              {loading ? (status || t('quick_sign.btn.activating')) : t('session_key.btn.activate')}
                            </button>
                            {wrongWallet && (
                              <p className={`text-xs mt-2 ${isDark ? 'text-red-400' : 'text-red-500'}`}>
                                {t('session_key.wrong_wallet')}
                              </p>
                            )}
                          </>
                        )
                      })()}
                    </div>
                  </>
                )}
                {session && isExpired && (
                  <p className={`text-sm mt-3 text-center ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
                    {t('session_key.previous_expired')}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
  )
}

export default SessionKeySettings

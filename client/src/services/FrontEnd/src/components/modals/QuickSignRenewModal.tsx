import React, { useState } from 'react'
import { useAccount, useChainId } from 'wagmi'
import ModalWrapper from './ModalWrapper'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { useActiveToken } from '~/store/tokenDataStore'
import { useCreateSession, getDefaultSpendLimit, getDefaultTipCeiling, DEFAULT_SESSION_DURATION } from '~/hooks/useSessionKey'
import { getTipTiers } from '~/api/actions'
import { HiLightningBolt } from 'react-icons/hi'
import QuickSignOptions from '~/components/QuickSignOptions'
import Tooltip from '~/components/Tooltip'
import { create } from 'zustand'

type RenewReason = 'expired' | 'spend_limit'

interface QuickSignRenewState {
  isOpen: boolean
  reason: RenewReason
  /** Callback to retry the action (will use wallet signature since QS is disabled) */
  onRetry: (() => Promise<any> | void) | null
  /** Fired when the modal is dismissed WITHOUT renewing/retrying. Lets the
   *  caller (signAndSubmit) reject its pending promise so the submit unwinds
   *  and the Post button resets from "Signing…" back to "Post". */
  onCancel: (() => void) | null
  show: (reason: RenewReason, onRetry?: () => Promise<any> | void, onCancel?: () => void) => void
  close: () => void
}

export const useQuickSignRenewStore = create<QuickSignRenewState>((set, get) => ({
  isOpen: false,
  reason: 'expired',
  onRetry: null,
  onCancel: null,
  show: (reason, onRetry, onCancel) => set({ isOpen: true, reason, onRetry: onRetry || null, onCancel: onCancel || null }),
  // Dismiss = cancel: fire onCancel once (so the awaiting submit rejects) and
  // clear both callbacks. handleRenew/handleSignManually null out onCancel
  // first when they take over, so this only fires on a genuine dismiss.
  close: () => {
    const { onCancel } = get()
    set({ isOpen: false, onRetry: null, onCancel: null })
    if (onCancel) onCancel()
  },
}))

const QuickSignRenewModal: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const { isOpen, reason, onRetry, close } = useQuickSignRenewStore()
  const setEnabled = useSessionKeyStore(s => s.setEnabled)
  const createSession = useCreateSession()
  const { address, isConnected } = useAccount()
  const ensureWallet = useEnsureWallet()
  const chainId = useChainId()
  const activeToken = useActiveToken()
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [spendLimit, setSpendLimit] = useState<bigint>(() => getDefaultSpendLimit())
  const [duration, setDuration] = useState<number>(DEFAULT_SESSION_DURATION)
  const [tipCeiling, setTipCeiling] = useState<bigint>(() => getDefaultTipCeiling(getTipTiers().fast))
  const [walletProtect, setWalletProtect] = useState(false)

  const wrongWallet = isConnected && activeToken && address
    ? activeToken.address.toLowerCase() !== address.toLowerCase()
    : false

  // Clear stale errors when connection state changes
  React.useEffect(() => { setError(null) }, [isConnected, address, chainId])

  const handleRenew = async () => {
    setLoading(true)
    setError(null)
    try {
      setEnabled(true)
      await createSession((s) => setStatus(s), spendLimit, duration, walletProtect, tipCeiling)
      // Fire the retry callback BEFORE closing so the caller can stitch
      // the new session into a queued action. Previously this path
      // closed the modal without ever invoking onRetry — meaning a
      // session-expired post-failure surfaced the modal, the user
      // renewed, the modal closed, and the failed action sat there
      // forever waiting for the user to manually re-post. The retry
      // is best-effort: a thrown error doesn't roll back the renewal
      // (the session IS valid now), just leaves the user with a stale
      // failed-notification they can click manually.
      const retry = onRetry
      // Renewing IS the success path — don't let close() fire onCancel (which
      // would reject the awaiting submit). Clear it first.
      useQuickSignRenewStore.setState({ onCancel: null })
      close()
      if (retry) {
        setTimeout(async () => {
          try { await retry() } catch (err) {
            console.warn('[QuickSign] onRetry after renew failed:', err)
          }
        }, 100)
      }
    } catch (err: any) {
      console.error('[QuickSign] Renewal failed:', err)
      const msg = err?.message || ''
      const isUserRejection = msg.includes('rejected') || msg.includes('denied') || msg.includes('cancelled') || err?.code === 4001
      setError(isUserRejection ? t('quick_sign.error.cancelled') : (msg.includes('Please') || msg.includes('try again') ? msg : t('quick_sign.error.generic')))
    } finally {
      setLoading(false)
      setStatus('')
    }
  }

  const handleSignManually = () => {
    // Don't proactively switch to L2 here. onRetry() ultimately calls
    // signAndSubmit which uses signTypedData; some wallets (Rabby silently,
    // mobile MM with a prompt) will auto-switch to match domain.chainId on
    // their own, so adding our switch on top of that wastes a wallet round-
    // trip. signAndSubmit's catch-and-retry path (api/actions.ts:1340-1351
    // and 1634-1641) is the safety net for the handful of wallets that
    // reject cross-chain typed-data signing instead of auto-switching.
    ensureWallet(null, async () => {
      if (wrongWallet) return

      // Temporarily disable Quick Sign so the retry uses wallet signature,
      // but don't clear the session — re-enable if the user cancels
      setEnabled(false)
      const retry = onRetry
      // "Sign manually" is also a deliberate retry, not a dismiss — clear
      // onCancel so close() doesn't reject the awaiting submit.
      useQuickSignRenewStore.setState({ onCancel: null })
      close()
      if (retry) {
        setTimeout(async () => {
          try {
            await retry()
          } catch {
            // User cancelled or signature failed — re-enable Quick Sign
            useSessionKeyStore.getState().setEnabled(true)
          }
        }, 100)
      }
    })
  }

  // Note: we used to show a "switch network first" hint here when the
  // wallet was on the wrong chain. Removed because we no longer require
  // L2 to sign — the wallet (or signAndSubmit's catch-and-retry path)
  // handles the chain on its own.

  const title = reason === 'expired'
    ? t('quick_sign_renew.title_expired')
    : t('quick_sign_renew.title_limit')

  const description = reason === 'expired'
    ? t('quick_sign_renew.desc_expired')
    : t('quick_sign_renew.desc_limit')

  return (
    <ModalWrapper isOpen={isOpen} onClose={close} usePortal maxWidth="max-w-[493px]">
      <div className="p-6">
        <div className="flex flex-col items-center gap-3 mb-4">
          <div className="p-2 rounded-full bg-yellow-500/20">
            <HiLightningBolt className="w-6 h-6 text-yellow-500" />
          </div>
          <h2 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-black'}`}>
            {title}
          </h2>
        </div>

        <p className={`text-sm mb-4 text-center ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
          {description}
        </p>

        <div className="mb-4">
          <QuickSignOptions
            spendLimit={spendLimit}
            onSpendLimitChange={setSpendLimit}
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
          <div className="mb-4 p-3 rounded-lg bg-red-900/20 border border-red-700/50 text-sm text-red-400">
            {error}
          </div>
        )}

        {wrongWallet && (
          <p className={`text-center text-xs mb-3 text-red-400`}>
            {t('quick_sign_renew.connect_correct_wallet', { username: activeToken?.username || '' })}
          </p>
        )}

        <div className="flex gap-3">
          {(() => {
            const renewBtn = (
              <button
                onClick={handleRenew}
                disabled={loading || !!wrongWallet}
                className="w-full px-4 py-3 rounded-full font-semibold bg-yellow-500 hover:bg-yellow-600 text-black transition-colors disabled:opacity-50 disabled:hover:bg-yellow-500 cursor-pointer disabled:cursor-not-allowed"
              >
                {loading ? (status || t('quick_sign.btn.activating')) : t('quick_sign_renew.btn.reenable')}
              </button>
            )
            return <div className="flex-1">{wrongWallet ? <Tooltip text={t('quick_sign_renew.connect_correct_wallet', { username: activeToken?.username || '' })}>{renewBtn}</Tooltip> : renewBtn}</div>
          })()}
          {(() => {
            const manualBtn = (
              <button
                onClick={handleSignManually}
                disabled={loading || !!wrongWallet}
                className={`w-full px-4 py-3 rounded-full font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  isDark
                    ? 'bg-white/10 text-white hover:bg-white/20 disabled:hover:bg-white/10 cursor-pointer'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:hover:bg-gray-100 cursor-pointer'
                }`}
              >
                {t('quick_sign.btn.sign_manually')}
              </button>
            )
            return <div className="flex-1">{wrongWallet ? <Tooltip text={t('quick_sign_renew.connect_correct_wallet', { username: activeToken?.username || '' })}>{manualBtn}</Tooltip> : manualBtn}</div>
          })()}
        </div>
      </div>
    </ModalWrapper>
  )
}

export default QuickSignRenewModal

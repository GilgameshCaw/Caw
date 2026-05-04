import React, { useState } from 'react'
import { useAccount, useChainId, useSwitchChain } from 'wagmi'
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
import { chains } from '~/config/chains'
import { create } from 'zustand'

type RenewReason = 'expired' | 'spend_limit'

interface QuickSignRenewState {
  isOpen: boolean
  reason: RenewReason
  /** Callback to retry the action (will use wallet signature since QS is disabled) */
  onRetry: (() => Promise<any> | void) | null
  show: (reason: RenewReason, onRetry?: () => Promise<any> | void) => void
  close: () => void
}

export const useQuickSignRenewStore = create<QuickSignRenewState>((set) => ({
  isOpen: false,
  reason: 'expired',
  onRetry: null,
  show: (reason, onRetry) => set({ isOpen: true, reason, onRetry: onRetry || null }),
  close: () => set({ isOpen: false, onRetry: null }),
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
  const { switchChain } = useSwitchChain()
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
  const wrongChain = isConnected && !wrongWallet && chainId !== chains.l2.chainId

  // Clear stale errors when connection state changes
  React.useEffect(() => { setError(null) }, [isConnected, address, chainId])

  const handleRenew = async () => {
    setLoading(true)
    setError(null)
    try {
      setEnabled(true)
      await createSession((s) => setStatus(s), spendLimit, duration, walletProtect, tipCeiling)
      close()
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
    ensureWallet({ chainId: chains.l2.chainId }, async () => {
      if (wrongWallet) return

      // Temporarily disable Quick Sign so the retry uses wallet signature,
      // but don't clear the session — re-enable if the user cancels
      setEnabled(false)
      const retry = onRetry
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

  const signManuallyNote = wrongWallet
    ? null // Handled by the dedicated wrong wallet message above buttons
    : wrongChain
      ? t('quick_sign_renew.switch_network_first')
      : null

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
        {signManuallyNote && !wrongWallet && (
          <p className={`text-center text-xs whitespace-nowrap mt-2 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
            <button onClick={() => wrongChain && switchChain({ chainId: chains.l2.chainId })} className="underline hover:opacity-80 cursor-pointer">
              {signManuallyNote}
            </button>
          </p>
        )}
      </div>
    </ModalWrapper>
  )
}

export default QuickSignRenewModal

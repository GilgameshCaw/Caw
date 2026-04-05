import React, { useState } from 'react'
import { useAccount, useChainId, useSwitchChain } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { useActiveToken } from '~/store/tokenDataStore'
import { useCreateSession, getDefaultSpendLimit, DEFAULT_SESSION_DURATION } from '~/hooks/useSessionKey'
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
  const { isOpen, reason, onRetry, close } = useQuickSignRenewStore()
  const setEnabled = useSessionKeyStore(s => s.setEnabled)
  const createSession = useCreateSession()
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const chainId = useChainId()
  const { switchChain } = useSwitchChain()
  const activeToken = useActiveToken()
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [spendLimit, setSpendLimit] = useState<bigint>(() => getDefaultSpendLimit())
  const [duration, setDuration] = useState<number>(DEFAULT_SESSION_DURATION)

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
      await createSession((s) => setStatus(s), spendLimit, duration)
      close()
    } catch (err: any) {
      console.error('[QuickSign] Renewal failed:', err)
      const msg = err?.message || ''
      const isUserRejection = msg.includes('rejected') || msg.includes('denied') || msg.includes('cancelled') || err?.code === 4001
      setError(isUserRejection ? 'Signature was cancelled.' : (msg.includes('Please') || msg.includes('try again') ? msg : 'Something went wrong. Please try again.'))
    } finally {
      setLoading(false)
      setStatus('')
    }
  }

  const handleSignManually = () => {
    if (!isConnected) {
      openConnectModal?.()
      return
    }
    if (wrongWallet) return
    if (wrongChain) {
      switchChain({ chainId: chains.l2.chainId })
      return
    }

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
  }

  const handleNoteClick = () => {
    if (!isConnected) {
      openConnectModal?.()
    } else if (wrongChain) {
      switchChain({ chainId: chains.l2.chainId })
    }
  }

  const signManuallyNote = wrongWallet
    ? null // Handled by the dedicated wrong wallet message above buttons
    : !isConnected
      ? 'Connect your wallet first'
      : wrongChain
        ? 'Switch to the correct network first'
        : null

  const title = reason === 'expired'
    ? 'Quick Sign Has Expired'
    : 'Quick Sign Spending Limit Reached'

  const description = reason === 'expired'
    ? 'Your Quick Sign session has expired. Re-sign to continue using Quick Sign, or sign this action manually with your wallet.'
    : 'Your Quick Sign session has reached its spending limit. Re-sign with a new session to continue, or sign this action manually with your wallet.'

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
            Please connect to the wallet that owns @{activeToken?.username}
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
                {loading ? (status || 'Activating...') : 'Re-enable Quick Sign'}
              </button>
            )
            return <div className="flex-1">{wrongWallet ? <Tooltip text={`Connect to the wallet that owns @${activeToken?.username}`}>{renewBtn}</Tooltip> : renewBtn}</div>
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
                Sign Manually
              </button>
            )
            return <div className="flex-1">{wrongWallet ? <Tooltip text={`Connect to the wallet that owns @${activeToken?.username}`}>{manualBtn}</Tooltip> : manualBtn}</div>
          })()}
        </div>
        {signManuallyNote && !wrongWallet && (
          <p className={`text-center text-xs whitespace-nowrap mt-2 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
            <button onClick={handleNoteClick} className="underline hover:opacity-80 cursor-pointer">
              {signManuallyNote}
            </button>
          </p>
        )}
      </div>
    </ModalWrapper>
  )
}

export default QuickSignRenewModal

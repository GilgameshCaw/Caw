import React, { useState } from 'react'
import { useAccount, useChainId, useSwitchChain } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { useActiveToken } from '~/store/tokenDataStore'
import { useCreateSession, DEFAULT_SPEND_LIMIT, DEFAULT_SESSION_DURATION } from '~/hooks/useSessionKey'
import { HiLightningBolt } from 'react-icons/hi'
import QuickSignOptions from '~/components/QuickSignOptions'
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
  const [spendLimit, setSpendLimit] = useState<bigint>(DEFAULT_SPEND_LIMIT)
  const [duration, setDuration] = useState<number>(DEFAULT_SESSION_DURATION)

  const wrongWallet = isConnected && activeToken && address
    ? activeToken.address.toLowerCase() !== address.toLowerCase()
    : false
  const wrongChain = isConnected && !wrongWallet && chainId !== chains.l2.chainId

  const handleRenew = async () => {
    setLoading(true)
    setError(null)
    try {
      setEnabled(true)
      await createSession((s) => setStatus(s), spendLimit, duration)
      close()
    } catch (err: any) {
      setError(err?.shortMessage || err?.message || 'Failed to activate')
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

  const signManuallyNote = !isConnected
    ? 'Connect your wallet first'
    : wrongWallet
      ? 'Wrong wallet connected'
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
    <ModalWrapper isOpen={isOpen} onClose={close} usePortal>
      <div className="p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-full bg-yellow-500/20">
            <HiLightningBolt className="w-6 h-6 text-yellow-500" />
          </div>
          <h2 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-black'}`}>
            {title}
          </h2>
        </div>

        <p className={`text-sm mb-4 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
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

        <div className="flex gap-3">
          <button
            onClick={handleRenew}
            disabled={loading}
            className="flex-1 py-3 rounded-full font-semibold bg-yellow-500 hover:bg-yellow-600 text-black transition-colors disabled:opacity-50 cursor-pointer"
          >
            {loading ? (status || 'Activating...') : 'Re-enable Quick Sign'}
          </button>
          <button
            onClick={handleSignManually}
            disabled={loading || wrongWallet}
            className={`flex-1 py-3 rounded-full font-semibold transition-colors ${
              wrongWallet
                ? 'text-red-400 bg-red-900/20 cursor-not-allowed'
                : isDark
                  ? 'bg-white/10 text-white hover:bg-white/20 cursor-pointer'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 cursor-pointer'
            } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            Sign Manually
          </button>
        </div>
        {signManuallyNote && (
          <p className={`text-center text-xs whitespace-nowrap mt-2 ${wrongWallet ? 'text-red-400' : isDark ? 'text-white/40' : 'text-gray-400'}`}>
            {wrongWallet ? signManuallyNote : (
              <button onClick={handleNoteClick} className="underline hover:opacity-80 cursor-pointer">
                {signManuallyNote}
              </button>
            )}
          </p>
        )}
      </div>
    </ModalWrapper>
  )
}

export default QuickSignRenewModal

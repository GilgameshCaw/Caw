import React, { useState, useEffect } from 'react'
import { create } from 'zustand'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { usePriceStore } from '~/store/tokenDataStore'
import { useCreateSession, getDefaultSpendLimit, DEFAULT_SESSION_DURATION } from '~/hooks/useSessionKey'
import { HiLightningBolt } from 'react-icons/hi'
import QuickSignOptions from '~/components/QuickSignOptions'

interface QuickSignPromptState {
  isOpen: boolean
  /** Callback to continue the action after the user decides */
  onContinue: (() => Promise<any> | void) | null
  /** Skip the prompt for the next action (set after "Sign Manually") */
  skipOnce: boolean
  show: (onContinue?: () => Promise<any> | void) => void
  close: () => void
}

export const useQuickSignPromptStore = create<QuickSignPromptState>((set) => ({
  isOpen: false,
  onContinue: null,
  skipOnce: false,
  show: (onContinue) => set({ isOpen: true, onContinue: onContinue || null }),
  close: () => set({ isOpen: false, onContinue: null }),
}))

interface QuickSignModalProps {
  isOpen?: boolean
  onClose?: () => void
}

const QuickSignModal: React.FC<QuickSignModalProps> = (props) => {
  const prompt = useQuickSignPromptStore()
  const isOpen = props.isOpen ?? prompt.isOpen
  const onClose = props.onClose ?? prompt.close
  const { isDark } = useTheme()
  const setEnabled = useSessionKeyStore(s => s.setEnabled)
  const createSession = useCreateSession()
  const setHasSeenPrompt = useSessionKeyStore(s => s.setHasSeenPrompt)
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [spendLimit, setSpendLimit] = useState<bigint>(() => getDefaultSpendLimit())
  const [duration, setDuration] = useState<number>(DEFAULT_SESSION_DURATION)
  const [dontShowAgain, setDontShowAgain] = useState(false)

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setError(null)
      if (cawPrice > 0) setSpendLimit(BigInt(Math.round(5 / cawPrice)))
    }
  }, [isOpen, cawPrice])

  const handleEnable = async () => {
    setLoading(true)
    setError(null)
    try {
      setEnabled(true)
      await createSession((s) => setStatus(s), spendLimit, duration)
      // Don't set hasSeenPrompt here — enabling Quick Sign is the "happy path".
      // The prompt naturally won't show while Quick Sign is active.
      const cont = prompt.onContinue
      onClose()
      // Retry the action now that Quick Sign is enabled
      if (cont) setTimeout(() => cont(), 100)
    } catch (err: any) {
      setError(err?.shortMessage || err?.message || 'Failed to activate')
      setEnabled(false)
    } finally {
      setLoading(false)
      setStatus('')
    }
  }

  const handleSkip = () => {
    // Only "don't show again" applies to manual signing — the user explicitly opts out
    if (dontShowAgain) setHasSeenPrompt(true)
    const cont = prompt.onContinue
    // Set skipOnce so the retry doesn't re-trigger the prompt
    useQuickSignPromptStore.setState({ skipOnce: true })
    onClose()
    // Continue with manual wallet signing
    if (cont) setTimeout(() => cont(), 100)
  }

  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} usePortal maxWidth="max-w-[540px]">
      <div className="p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-full bg-yellow-500/20">
            <HiLightningBolt className="w-6 h-6 text-yellow-500" />
          </div>
          <h2 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-black'}`}>
            Enable Quick Sign?
          </h2>
        </div>

        <p className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`} style={{ marginBottom: 15 }}>
          You're ready to start posting! Quick Sign lets you interact without a wallet
          popup every time — your browser handles signing automatically.
        </p>

        <div className="bg-yellow-900/20 border border-yellow-700/50 rounded-lg p-3 mb-4 text-sm">
          <p className={`${isDark ? 'text-gray-300' : 'text-gray-600'}`} style={{ marginBottom: 10 }}>
            This creates a temporary key in your browser that can act on your behalf.
          </p>
          <p className={`${isDark ? 'text-gray-300' : 'text-gray-600'}`} style={{ marginBottom: 10 }}>
            It <strong>cannot withdraw tokens or transfer your name</strong>.
          </p>
          <p className={`${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
            You can revoke it anytime in Settings.
          </p>
        </div>

        <div className="mb-3">
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

        {/* Don't show again checkbox */}
        <label className="flex items-center justify-center gap-2 mb-5 cursor-pointer text-sm text-white/60">
          <button
            type="button"
            role="checkbox"
            aria-checked={dontShowAgain}
            onClick={() => setDontShowAgain(!dontShowAgain)}
            className={`w-4 h-4 rounded flex-shrink-0 flex items-center justify-center transition-colors duration-150 ${
              dontShowAgain
                ? 'bg-yellow-500'
                : 'bg-black border border-white/30'
            }`}
          >
            {dontShowAgain && (
              <svg className="w-3 h-3 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
          Don't show this again
        </label>

        <div className="flex gap-3">
          <button
            onClick={handleEnable}
            disabled={loading}
            className="flex-1 py-3 rounded-full font-semibold bg-yellow-500 hover:bg-yellow-600 text-black transition-colors disabled:opacity-50 cursor-pointer"
          >
            {loading ? (status || 'Activating...') : 'Enable Quick Sign'}
          </button>
          <button
            onClick={handleSkip}
            disabled={loading}
            className={`flex-1 py-3 rounded-full font-semibold transition-colors cursor-pointer ${
              isDark
                ? 'bg-white/10 text-white hover:bg-white/20'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            Sign Manually
          </button>
        </div>

        <p className={`text-xs text-center mt-3 ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
          You can manage Quick Sign anytime in Settings
        </p>
      </div>
    </ModalWrapper>
  )
}

export default QuickSignModal

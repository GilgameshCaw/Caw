import React, { useState, useEffect } from 'react'
import { create } from 'zustand'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { usePriceStore } from '~/store/tokenDataStore'
import { useCreateSession, getDefaultSpendLimit, getDefaultTipCeiling, DEFAULT_SESSION_DURATION } from '~/hooks/useSessionKey'
import { getTipTiers } from '~/api/actions'
import { HiLightningBolt } from 'react-icons/hi'
import QuickSignOptions from '~/components/QuickSignOptions'

interface QuickSignPromptState {
  isOpen: boolean
  /** Callback to continue the action after the user decides */
  onContinue: (() => Promise<any> | void) | null
  /** Called when the modal is dismissed without the user choosing an action */
  onDismiss: (() => void) | null
  /** Skip the prompt for the next action (set after "Sign Manually") */
  skipOnce: boolean
  show: (onContinue?: () => Promise<any> | void, onDismiss?: () => void) => void
  close: () => void
}

export const useQuickSignPromptStore = create<QuickSignPromptState>((set, get) => ({
  isOpen: false,
  onContinue: null,
  onDismiss: null,
  skipOnce: false,
  show: (onContinue, onDismiss) => set({ isOpen: true, onContinue: onContinue || null, onDismiss: onDismiss || null }),
  close: () => {
    const { onDismiss } = get()
    set({ isOpen: false, onContinue: null, onDismiss: null })
    // If neither "Enable Quick Sign" nor "Sign Manually" was chosen,
    // fire onDismiss so the caller's promise can settle and reset UI state.
    if (onDismiss) onDismiss()
  },
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
  const t = useT()
  const setEnabled = useSessionKeyStore(s => s.setEnabled)
  const createSession = useCreateSession()
  const setHasSeenPrompt = useSessionKeyStore(s => s.setHasSeenPrompt)
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [spendLimit, setSpendLimit] = useState<bigint>(() => getDefaultSpendLimit())
  const [duration, setDuration] = useState<number>(DEFAULT_SESSION_DURATION)
  const [tipCeiling, setTipCeiling] = useState<bigint>(() => getDefaultTipCeiling(getTipTiers().fast))
  const [dontShowAgain, setDontShowAgain] = useState(false)
  const [walletProtect, setWalletProtect] = useState(false)

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setError(null)
      if (cawPrice > 0) setSpendLimit(BigInt(Math.round(5 / cawPrice)))
      // Re-fetch market tip in case it changed since the component mounted
      setTipCeiling(getDefaultTipCeiling(getTipTiers().fast))
    }
  }, [isOpen, cawPrice])

  const handleEnable = async () => {
    setLoading(true)
    setError(null)
    try {
      setEnabled(true)
      await createSession((s) => setStatus(s), spendLimit, duration, walletProtect, tipCeiling)
      // Don't set hasSeenPrompt here — enabling Quick Sign is the "happy path".
      // The prompt naturally won't show while Quick Sign is active.
      const cont = prompt.onContinue
      // Clear onDismiss before closing — this is a deliberate action, not a dismiss
      useQuickSignPromptStore.setState({ onDismiss: null })
      onClose()
      // Retry the action now that Quick Sign is enabled
      if (cont) setTimeout(() => cont(), 100)
    } catch (err: any) {
      console.error('[QuickSign] Activation failed:', err)
      // Show user-friendly message; raw error already logged by the hook
      const msg = err?.message || ''
      const isUserRejection = msg.includes('rejected') || msg.includes('denied') || msg.includes('cancelled') || err?.code === 4001
      setError(isUserRejection ? t('quick_sign.error.cancelled') : (msg.includes('Please') || msg.includes('try again') ? msg : t('quick_sign.error.generic')))
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
    // Clear onDismiss before closing — this is a deliberate action, not a dismiss
    useQuickSignPromptStore.setState({ skipOnce: true, onDismiss: null })
    onClose()
    // Continue with manual wallet signing
    if (cont) setTimeout(() => cont(), 100)
  }

  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} usePortal maxWidth="max-w-[600px]">
      <div className="p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-full bg-yellow-500/20">
            <HiLightningBolt className="w-6 h-6 text-yellow-500" />
          </div>
          <h2 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-black'}`}>
            {t('quick_sign.prompt.title')}
          </h2>
        </div>

        <p className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`} style={{ marginBottom: 15 }}>
          {t('quick_sign.prompt.intro')}
        </p>

        <div className="bg-yellow-900/20 border border-yellow-700/50 rounded-lg p-3 mb-4 text-sm">
          <p className={`${isDark ? 'text-gray-300' : 'text-gray-600'}`} style={{ marginBottom: 10 }}>
            {t('quick_sign.prompt.info1')}
          </p>
          <p className={`${isDark ? 'text-gray-300' : 'text-gray-600'}`} style={{ marginBottom: 10 }}>
            {t('quick_sign.prompt.info2_before')}<strong>{t('quick_sign.prompt.info2_strong')}</strong>{t('quick_sign.prompt.info2_after')}
          </p>
          <p className={`${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
            {t('quick_sign.prompt.info3')}
          </p>
        </div>

        <div className="mb-3">
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
          <div className="mb-4 p-3 rounded-lg bg-red-900/20 border border-red-700/50 text-sm text-red-400 text-center">
            {error}
          </div>
        )}

        {/* Don't show again checkbox */}
        <label className={`flex items-center justify-center gap-2 mb-5 cursor-pointer text-sm ${
          isDark ? 'text-white/60' : 'text-gray-600'
        }`}>
          <button
            type="button"
            role="checkbox"
            aria-checked={dontShowAgain}
            onClick={() => setDontShowAgain(!dontShowAgain)}
            className={`w-4 h-4 rounded flex-shrink-0 flex items-center justify-center transition-colors duration-150 ${
              dontShowAgain
                ? 'bg-yellow-500'
                : isDark
                  ? 'bg-black border border-white/30'
                  : 'bg-white border border-gray-300'
            }`}
          >
            {dontShowAgain && (
              <svg className="w-3 h-3 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
          {t('common.dont_show_again')}
        </label>

        <div className="flex gap-3">
          <button
            onClick={handleEnable}
            disabled={loading}
            className="flex-1 py-3 rounded-full font-semibold bg-yellow-500 hover:bg-yellow-600 text-black transition-colors disabled:opacity-50 cursor-pointer"
          >
            {loading ? (status || t('quick_sign.btn.activating')) : t('quick_sign.btn.enable')}
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
            {t('quick_sign.btn.sign_manually')}
          </button>
        </div>

        <p className={`text-xs text-center mt-3 ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
          {t('quick_sign.manage_note')}
        </p>
      </div>
    </ModalWrapper>
  )
}

export default QuickSignModal

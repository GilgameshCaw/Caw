import React, { useState } from 'react'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { useCreateSession, DEFAULT_SPEND_LIMIT, DEFAULT_SESSION_DURATION } from '~/hooks/useSessionKey'
import { HiLightningBolt } from 'react-icons/hi'
import QuickSignOptions from '~/components/QuickSignOptions'

interface QuickSignModalProps {
  isOpen: boolean
  onClose: () => void
}

const QuickSignModal: React.FC<QuickSignModalProps> = ({ isOpen, onClose }) => {
  const { isDark } = useTheme()
  const setEnabled = useSessionKeyStore(s => s.setEnabled)
  const createSession = useCreateSession()
  const setHasSeenPrompt = useSessionKeyStore(s => s.setHasSeenPrompt)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [spendLimit, setSpendLimit] = useState<bigint>(DEFAULT_SPEND_LIMIT)
  const [duration, setDuration] = useState<number>(DEFAULT_SESSION_DURATION)
  const [dontShowAgain, setDontShowAgain] = useState(false)

  const handleEnable = async () => {
    setLoading(true)
    setError(null)
    try {
      setEnabled(true)
      await createSession((s) => setStatus(s), spendLimit, duration)
      if (dontShowAgain) setHasSeenPrompt(true)
      onClose()
    } catch (err: any) {
      setError(err?.shortMessage || err?.message || 'Failed to activate')
      setEnabled(false)
    } finally {
      setLoading(false)
      setStatus('')
    }
  }

  const handleSkip = () => {
    if (dontShowAgain) setHasSeenPrompt(true)
    onClose()
  }

  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} usePortal>
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
            This creates a temporary key in your browser that can post, like, and follow
            on your behalf.
          </p>
          <p className={`${isDark ? 'text-gray-300' : 'text-gray-600'}`} style={{ marginBottom: 10 }}>
            It <strong>cannot withdraw tokens or transfer your name</strong>.
          </p>
          <p className={`${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
            You can revoke it anytime in Settings.
          </p>
        </div>

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

        {/* Don't show again checkbox */}
        <label className="flex items-center gap-2 mb-4 cursor-pointer text-sm text-white/60">
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
            Not now
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

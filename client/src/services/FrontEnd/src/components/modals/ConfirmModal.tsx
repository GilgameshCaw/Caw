import React, { useState } from 'react'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'

interface ConfirmModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  destructive?: boolean
  /**
   * If set, shows a "Don't show this again" checkbox. When checked at
   * confirm time, writes `true` to localStorage[`confirmAck:${rememberKey}`].
   * Callers should check `wasAcknowledged(rememberKey)` before opening
   * the modal — if true, skip the modal and call onConfirm() directly.
   *
   * Cancel never sets the flag — only an explicit "yes proceed" suppresses
   * future prompts. Stops users who change their mind from accidentally
   * disabling the safety prompt.
   */
  rememberKey?: string
}

const REMEMBER_PREFIX = 'confirmAck:'

/**
 * Has the user previously acknowledged this confirm prompt with
 * "Don't show again" checked? Use at the callsite to decide whether to
 * open the modal or just run the confirm action directly.
 */
export function wasAcknowledged(rememberKey: string): boolean {
  try {
    return localStorage.getItem(REMEMBER_PREFIX + rememberKey) === 'true'
  } catch {
    return false
  }
}

/** Re-prompt the user next time. Useful for a Settings → "Reset prompts" UX. */
export function clearAcknowledgement(rememberKey: string) {
  try { localStorage.removeItem(REMEMBER_PREFIX + rememberKey) } catch {}
}

const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText,
  cancelText,
  destructive = false,
  rememberKey,
}) => {
  const { isDark } = useTheme()
  const t = useT()
  const [dontShowAgain, setDontShowAgain] = useState(false)
  const effectiveConfirmText = confirmText ?? t('common.confirm')
  const effectiveCancelText  = cancelText  ?? t('common.cancel')

  const handleConfirm = () => {
    if (rememberKey && dontShowAgain) {
      try { localStorage.setItem(REMEMBER_PREFIX + rememberKey, 'true') } catch {}
    }
    onConfirm()
    onClose()
  }

  return (
    <ModalWrapper
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="max-w-sm"
      zIndex={80}
      usePortal
      backdropClass="bg-black/60"
    >
      <div className="p-5">
        <h3 className={`text-lg font-semibold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
          {title}
        </h3>
        <div className={`text-sm mb-5 space-y-2 ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
          {message.split('\n\n').map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
        </div>
        {rememberKey && (
          <label className={`flex items-center gap-2 mb-4 cursor-pointer text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
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
        )}
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
              isDark
                ? 'bg-white/10 text-white hover:bg-white/20'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {effectiveCancelText}
          </button>
          <button
            onClick={handleConfirm}
            className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
              destructive
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-yellow-500 text-black hover:bg-yellow-400'
            }`}
          >
            {effectiveConfirmText}
          </button>
        </div>
      </div>
    </ModalWrapper>
  )
}

export default ConfirmModal

/**
 * SignInChoiceModal.tsx
 *
 * "How would you like to sign in?" chooser modal.
 *
 * Presents two entry points:
 *   - Wallet path  (Population A) — MetaMask / Rainbow / Coinbase Wallet etc.
 *   - Passkey path (Population B) — Face ID / Touch ID / device PIN
 *
 * A footer link routes directly to /recovery for users who already have a
 * passkey account but are signing in from a new device via backup file.
 *
 * The modal does NOT execute any signing logic itself — callers supply
 * onWalletPath and onPasskeyPath callbacks.
 */

import React from 'react'
import { HiFingerPrint } from 'react-icons/hi'
import { HiWallet } from 'react-icons/hi2'
import { useNavigate } from '~/utils/localizedRouter'
import ModalWrapper from '~/components/modals/ModalWrapper'
import ModalHeader from '~/components/modals/ModalHeader'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'

// ─── Public interface ─────────────────────────────────────────────────────────

export interface SignInChoiceModalProps {
  open: boolean
  onClose: () => void
  /** Called when the user chooses the wallet path. Typically calls openConnectModal(). */
  onWalletPath: () => void
  /** Called when the user chooses the passkey path. Typically navigates to /onboarding. */
  onPasskeyPath: () => void
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SignInChoiceModal({
  open,
  onClose,
  onWalletPath,
  onPasskeyPath,
}: SignInChoiceModalProps): JSX.Element {
  const { isDark } = useTheme()
  const t = useT()
  const navigate = useNavigate()

  const strongClass = isDark ? 'text-white' : 'text-gray-900'
  const mutedClass  = isDark ? 'text-white/60' : 'text-gray-500'

  const handleWallet = () => {
    onClose()
    onWalletPath()
  }

  const handlePasskey = () => {
    onClose()
    onPasskeyPath()
  }

  const handleRecovery = () => {
    onClose()
    navigate('/recovery')
  }

  const choiceBtnBase = `
    flex flex-col items-center justify-center gap-3 p-6 rounded-xl border-2
    transition-all duration-150 cursor-pointer w-full
    focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-500
  `
  const choiceBtnDark  = 'border-white/20 hover:border-yellow-500/60 hover:bg-yellow-500/5'
  const choiceBtnLight = 'border-gray-200 hover:border-yellow-500/60 hover:bg-yellow-50'

  return (
    <ModalWrapper
      isOpen={open}
      onClose={onClose}
      maxWidth="max-w-sm"
      zIndex={80}
      usePortal
      backdropClass="bg-black/60"
    >
      <ModalHeader
        title={t('signin_choice.title')}
        onClose={onClose}
        icon={null}
        iconBg="bg-yellow-500/20"
      />

      <div className="px-4 pb-5 space-y-3">
        {/* Row of two choice buttons — side-by-side; stacks are too tall on small screens */}
        <div className="flex gap-3 pt-1" data-testid="choice-buttons">
          {/* Wallet option */}
          <button
            type="button"
            data-testid="wallet-choice-btn"
            onClick={handleWallet}
            className={`${choiceBtnBase} ${isDark ? choiceBtnDark : choiceBtnLight}`}
          >
            <div className={`p-3 rounded-full ${isDark ? 'bg-yellow-500/15' : 'bg-yellow-100'}`}>
              <HiWallet className="w-7 h-7 text-yellow-500" />
            </div>
            <div className="text-center">
              <p className={`text-sm font-semibold ${strongClass}`}>
                {t('signin_choice.wallet.label')}
              </p>
              <p className={`text-xs mt-0.5 ${mutedClass}`}>
                {t('signin_choice.wallet.subtext')}
              </p>
            </div>
          </button>

          {/* Passkey option */}
          <button
            type="button"
            data-testid="passkey-choice-btn"
            onClick={handlePasskey}
            className={`${choiceBtnBase} ${isDark ? choiceBtnDark : choiceBtnLight}`}
          >
            <div className={`p-3 rounded-full ${isDark ? 'bg-yellow-500/15' : 'bg-yellow-100'}`}>
              <HiFingerPrint className="w-7 h-7 text-yellow-500" />
            </div>
            <div className="text-center">
              <p className={`text-sm font-semibold ${strongClass}`}>
                {t('signin_choice.passkey.label')}
              </p>
              <p className={`text-xs mt-0.5 ${mutedClass}`}>
                {t('signin_choice.passkey.subtext')}
              </p>
            </div>
          </button>
        </div>

        {/* Recovery footer link */}
        <p className={`text-xs text-center pt-1 ${mutedClass}`}>
          <button
            type="button"
            data-testid="recovery-link"
            onClick={handleRecovery}
            className={`underline underline-offset-2 cursor-pointer transition-colors ${
              isDark ? 'hover:text-white/90' : 'hover:text-gray-700'
            }`}
          >
            {t('signin_choice.recovery_link')}
          </button>
        </p>
      </div>
    </ModalWrapper>
  )
}

export default SignInChoiceModal

/**
 * Onboarding.tsx
 *
 * Multi-step onboarding for new users who arrive via the "I don't have a
 * wallet" link on the connect modal. Builds a phone-first (EIP-7702 /
 * Population B) identity without requiring the user to already own a wallet.
 *
 * Steps:
 *  1. username       — pick & verify username availability
 *  2. deposit        — choose CAW deposit amount
 *  3. vault-password — set vault password protecting the backup blob
 *  4. passkey        — enroll WebAuthn passkey (Face ID / Touch ID / Windows Hello)
 *  5. backup         — bootstrapNewUser() + download recovery file
 *  6. confirm        — success + txHash + navigate to feed
 */

import { useState, useCallback } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import UsernameStep from './onboarding/UsernameStep'
import DepositStep, { MIN_DEPOSIT_CAW } from './onboarding/DepositStep'
import VaultPasswordStep from './onboarding/VaultPasswordStep'
import PasskeyStep from './onboarding/PasskeyStep'
import BackupStep from './onboarding/BackupStep'
import ConfirmStep from './onboarding/ConfirmStep'
import type { PasskeyPubkey } from '~/services/identity/passkey'
import type { BootstrapResult } from '~/services/identity/bootstrap'

type OnboardingStep =
  | 'username'
  | 'deposit'
  | 'vault-password'
  | 'passkey'
  | 'backup'
  | 'confirm'

interface OnboardingState {
  step: OnboardingStep
  username: string
  usernameAvailable: boolean | null
  usernameError: string | null
  depositAmount: bigint
  vaultPassword: string
  vaultPasswordConfirm: string
  enrolledPasskey: PasskeyPubkey | null
  bootstrapResult: BootstrapResult | null
}

const INITIAL_STATE: OnboardingState = {
  step: 'username',
  username: '',
  usernameAvailable: null,
  usernameError: null,
  depositAmount: MIN_DEPOSIT_CAW,
  vaultPassword: '',
  vaultPasswordConfirm: '',
  enrolledPasskey: null,
  bootstrapResult: null,
}

// Steps that show in the progress indicator (exclude the confirm step).
const PROGRESS_STEPS: OnboardingStep[] = [
  'username',
  'deposit',
  'vault-password',
  'passkey',
  'backup',
]

const ALL_STEPS: OnboardingStep[] = [
  'username',
  'deposit',
  'vault-password',
  'passkey',
  'backup',
  'confirm',
]

function stepIndex(step: OnboardingStep): number {
  return ALL_STEPS.indexOf(step)
}

function stepLabel(step: OnboardingStep, t: (k: string) => string): string {
  switch (step) {
    case 'username':       return t('onboarding.step.username')
    case 'deposit':        return t('onboarding.step.deposit')
    case 'vault-password': return t('onboarding.step.vault_password')
    case 'passkey':        return t('onboarding.step.passkey')
    case 'backup':         return t('onboarding.step.backup')
    case 'confirm':        return t('onboarding.step.confirm')
  }
}

export default function Onboarding() {
  const { isDark } = useTheme()
  const t = useT()
  const [state, setState] = useState<OnboardingState>(INITIAL_STATE)

  const currentIndex = stepIndex(state.step)
  const totalSteps = PROGRESS_STEPS.length
  const showProgress = PROGRESS_STEPS.includes(state.step as typeof PROGRESS_STEPS[number])
  const progressIndex = PROGRESS_STEPS.indexOf(state.step as typeof PROGRESS_STEPS[number])

  const mutedClass = isDark ? 'text-white/50' : 'text-gray-500'
  const strongClass = isDark ? 'text-white' : 'text-gray-900'

  // ── Navigation ────────────────────────────────────────────────────────────

  const goNext = useCallback(() => {
    const nextIndex = stepIndex(state.step) + 1
    if (nextIndex < ALL_STEPS.length) {
      setState(s => ({ ...s, step: ALL_STEPS[nextIndex] }))
    }
  }, [state.step])

  const goBack = useCallback(() => {
    const prevIndex = stepIndex(state.step) - 1
    if (prevIndex >= 0) {
      setState(s => ({ ...s, step: ALL_STEPS[prevIndex] }))
    }
  }, [state.step])

  // ── State setters ─────────────────────────────────────────────────────────

  const handleUsernameChange = useCallback((username: string) => {
    setState(s => ({ ...s, username, usernameAvailable: null, usernameError: null }))
  }, [])

  const handleAvailabilityChange = useCallback((available: boolean | null) => {
    setState(s => ({ ...s, usernameAvailable: available }))
  }, [])

  const handleDepositChange = useCallback((depositAmount: bigint) => {
    setState(s => ({ ...s, depositAmount }))
  }, [])

  const handlePasswordChange = useCallback((vaultPassword: string) => {
    setState(s => ({ ...s, vaultPassword }))
  }, [])

  const handleConfirmChange = useCallback((vaultPasswordConfirm: string) => {
    setState(s => ({ ...s, vaultPasswordConfirm }))
  }, [])

  // PasskeyStep → advances to 'backup' after successful enrollment
  const handlePasskeyEnrolled = useCallback((passkey: PasskeyPubkey) => {
    setState(s => ({ ...s, enrolledPasskey: passkey, step: 'backup' }))
  }, [])

  // BackupStep → advances to 'confirm' after successful bootstrap
  const handleBootstrapDone = useCallback((result: BootstrapResult) => {
    setState(s => ({ ...s, bootstrapResult: result, step: 'confirm' }))
  }, [])

  // BackupStep → USERNAME_TAKEN: return to username step with error hint
  const handleUsernameTaken = useCallback(() => {
    setState(s => ({
      ...s,
      step: 'username',
      usernameAvailable: false,
      usernameError: t('onboarding.username.taken_retry'),
    }))
  }, [t])

  return (
    <div className={`min-h-screen flex flex-col ${isDark ? 'bg-black' : 'bg-white'}`}>
      {/* Header bar */}
      <div className={`sticky top-0 z-10 border-b px-6 py-4 ${isDark ? 'bg-black/90 border-white/10' : 'bg-white/90 border-gray-200'} backdrop-blur-sm`}>
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Back arrow — hidden on first step and confirm */}
            {currentIndex > 0 && state.step !== 'confirm' && (
              <button
                onClick={goBack}
                className={`p-1 rounded-lg transition-colors cursor-pointer ${isDark ? 'hover:bg-white/10 text-white/70' : 'hover:bg-gray-100 text-gray-600'}`}
                aria-label={t('common.back')}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            )}
            <div>
              <h1 className={`text-base font-semibold ${strongClass}`}>
                {t('onboarding.title')}
              </h1>
              {showProgress && (
                <p className={`text-xs ${mutedClass}`}>
                  {t('onboarding.step_of', {
                    current: String(progressIndex + 1),
                    total: String(totalSteps),
                  })}
                </p>
              )}
            </div>
          </div>

          {/* Step label */}
          {showProgress && (
            <span className={`text-xs font-medium ${mutedClass}`}>
              {stepLabel(state.step, t)}
            </span>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {showProgress && (
        <div className={`h-0.5 ${isDark ? 'bg-white/10' : 'bg-gray-100'}`}>
          <div
            className="h-full bg-yellow-500 transition-all duration-500"
            style={{ width: `${((progressIndex + 1) / totalSteps) * 100}%` }}
          />
        </div>
      )}

      {/* Step content */}
      <div className="flex-1 flex items-start justify-center px-6 py-8">
        <div className="w-full max-w-lg">
          {state.step === 'username' && (
            <UsernameStep
              username={state.username}
              usernameAvailable={state.usernameAvailable}
              onUsernameChange={handleUsernameChange}
              onAvailabilityChange={handleAvailabilityChange}
              onNext={goNext}
            />
          )}

          {state.step === 'deposit' && (
            <DepositStep
              depositAmount={state.depositAmount}
              onDepositChange={handleDepositChange}
              onNext={goNext}
              onBack={goBack}
            />
          )}

          {state.step === 'vault-password' && (
            <VaultPasswordStep
              vaultPassword={state.vaultPassword}
              vaultPasswordConfirm={state.vaultPasswordConfirm}
              onPasswordChange={handlePasswordChange}
              onConfirmChange={handleConfirmChange}
              onNext={goNext}
              onBack={goBack}
            />
          )}

          {state.step === 'passkey' && (
            <PasskeyStep
              username={state.username}
              onNext={handlePasskeyEnrolled}
              onBack={goBack}
            />
          )}

          {state.step === 'backup' && state.enrolledPasskey && (
            <BackupStep
              username={state.username}
              depositAmount={state.depositAmount}
              vaultPassword={state.vaultPassword}
              passkey={state.enrolledPasskey}
              onNext={handleBootstrapDone}
              onUsernameTaken={handleUsernameTaken}
              onBack={goBack}
            />
          )}

          {state.step === 'confirm' && state.bootstrapResult && (
            <ConfirmStep
              username={state.username}
              txHash={state.bootstrapResult.txHash}
            />
          )}
        </div>
      </div>
    </div>
  )
}

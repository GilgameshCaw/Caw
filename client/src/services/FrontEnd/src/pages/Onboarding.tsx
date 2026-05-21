/**
 * Onboarding.tsx
 *
 * Multi-step onboarding for new users who arrive via the "I don't have a
 * wallet" link on the connect modal. Builds a phone-first (EIP-7702 /
 * Population B) identity without requiring the user to already own a wallet.
 *
 * Wave 1: UI skeleton only — no backend wiring.
 * Wave 2 will call bootstrapNewUser() + passkey enrollment + blob download.
 *
 * Steps:
 *  1. username   — pick & verify username availability
 *  2. deposit    — choose CAW deposit amount
 *  3. vault-password — set vault password protecting the backup blob
 *  4. next       — Wave-2 stub
 */

import { useState, useCallback } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import UsernameStep from './onboarding/UsernameStep'
import DepositStep, { MIN_DEPOSIT_CAW } from './onboarding/DepositStep'
import VaultPasswordStep from './onboarding/VaultPasswordStep'

type OnboardingStep = 'username' | 'deposit' | 'vault-password' | 'next'

interface OnboardingState {
  step: OnboardingStep
  username: string
  usernameAvailable: boolean | null
  depositAmount: bigint
  vaultPassword: string
  vaultPasswordConfirm: string
}

const INITIAL_STATE: OnboardingState = {
  step: 'username',
  username: '',
  usernameAvailable: null,
  depositAmount: MIN_DEPOSIT_CAW,
  vaultPassword: '',
  vaultPasswordConfirm: '',
}

const STEP_ORDER: OnboardingStep[] = ['username', 'deposit', 'vault-password', 'next']

function stepIndex(step: OnboardingStep): number {
  return STEP_ORDER.indexOf(step)
}

function stepLabel(step: OnboardingStep, t: (k: string) => string): string {
  switch (step) {
    case 'username': return t('onboarding.step.username')
    case 'deposit': return t('onboarding.step.deposit')
    case 'vault-password': return t('onboarding.step.vault_password')
    case 'next': return t('onboarding.step.next')
  }
}

export default function Onboarding() {
  const { isDark } = useTheme()
  const t = useT()
  const [state, setState] = useState<OnboardingState>(INITIAL_STATE)

  const currentIndex = stepIndex(state.step)
  const totalSteps = STEP_ORDER.length - 1 // exclude stub "next" from progress display

  const mutedClass = isDark ? 'text-white/50' : 'text-gray-500'
  const strongClass = isDark ? 'text-white' : 'text-gray-900'

  // ── Navigation ────────────────────────────────────────────────────────────

  const goNext = useCallback(() => {
    const nextIndex = stepIndex(state.step) + 1
    if (nextIndex < STEP_ORDER.length) {
      setState(s => ({ ...s, step: STEP_ORDER[nextIndex] }))
    }
  }, [state.step])

  const goBack = useCallback(() => {
    const prevIndex = stepIndex(state.step) - 1
    if (prevIndex >= 0) {
      setState(s => ({ ...s, step: STEP_ORDER[prevIndex] }))
    }
  }, [state.step])

  // ── State setters ─────────────────────────────────────────────────────────

  const handleUsernameChange = useCallback((username: string) => {
    setState(s => ({ ...s, username, usernameAvailable: null }))
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

  // ── Progress indicator (shown for steps 0–2; hidden on stub) ─────────────

  const showProgress = state.step !== 'next'

  return (
    <div className={`min-h-screen flex flex-col ${isDark ? 'bg-black' : 'bg-white'}`}>
      {/* Header bar */}
      <div className={`sticky top-0 z-10 border-b px-6 py-4 ${isDark ? 'bg-black/90 border-white/10' : 'bg-white/90 border-gray-200'} backdrop-blur-sm`}>
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Back arrow — hidden on first step */}
            {currentIndex > 0 && state.step !== 'next' && (
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
                    current: String(currentIndex + 1),
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
            style={{ width: `${((currentIndex + 1) / totalSteps) * 100}%` }}
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

          {state.step === 'next' && (
            <div className="space-y-6 text-center">
              <div className={`w-16 h-16 mx-auto rounded-full flex items-center justify-center ${isDark ? 'bg-yellow-500/20' : 'bg-yellow-100'}`}>
                <svg className="w-8 h-8 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
              </div>
              <h2 className={`text-2xl font-bold ${strongClass}`}>
                {t('onboarding.next.title')}
              </h2>
              <p className={`text-sm ${mutedClass} max-w-sm mx-auto`}>
                Wave 2 wires this up — passkey enrollment + backup blob + sponsor call go here.
              </p>
              <div className={`rounded-xl p-4 text-left space-y-2 ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                <p className={`text-xs font-mono ${mutedClass}`}>Selected: @{state.username}</p>
                <p className={`text-xs font-mono ${mutedClass}`}>
                  Deposit: {(Number(state.depositAmount / 10n ** 18n)).toLocaleString()} CAW
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

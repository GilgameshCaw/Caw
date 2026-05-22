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

import React, { useState, useCallback } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useNavigate } from '~/utils/localizedRouter'
import UsernameStep from './onboarding/UsernameStep'
import DepositStep, { MIN_DEPOSIT_CAW } from './onboarding/DepositStep'
import VaultPasswordStep from './onboarding/VaultPasswordStep'
import PasskeyStep from './onboarding/PasskeyStep'
import BackupStep from './onboarding/BackupStep'
import ConfirmStep from './onboarding/ConfirmStep'
import BoidsBg from '~/components/BoidsBg'
import LanguageSwitcher from '~/components/LanguageSwitcher'
import {
  HiAtSymbol,
  HiCurrencyDollar,
  HiLockClosed,
  HiFingerPrint,
  HiCloudDownload,
  HiCheck,
} from 'react-icons/hi'
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

// Steps that show in the segmented stepper (exclude the confirm step).
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

interface StepMeta {
  id: OnboardingStep
  icon: React.ReactNode
  shortLabel: string
}

// Icon size matches PostMintOnboarding (w-4 h-4 inside the label row)
const STEP_META: StepMeta[] = [
  { id: 'username',       icon: <HiAtSymbol className="w-4 h-4" />,      shortLabel: '@' },
  { id: 'deposit',        icon: <HiCurrencyDollar className="w-4 h-4" />, shortLabel: 'CAW' },
  { id: 'vault-password', icon: <HiLockClosed className="w-4 h-4" />,     shortLabel: 'Vault' },
  { id: 'passkey',        icon: <HiFingerPrint className="w-4 h-4" />,    shortLabel: 'Key' },
  { id: 'backup',         icon: <HiCloudDownload className="w-4 h-4" />,  shortLabel: 'Save' },
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
  const navigate = useNavigate()
  const [state, setState] = useState<OnboardingState>(INITIAL_STATE)

  const showProgress = PROGRESS_STEPS.includes(state.step as typeof PROGRESS_STEPS[number])
  const progressIndex = PROGRESS_STEPS.indexOf(state.step as typeof PROGRESS_STEPS[number])

  // Theme helpers — mirrors PostMintOnboarding tc object pattern
  const outerBg = isDark ? 'bg-black' : 'bg-white'
  const textPrimary = isDark ? 'text-white' : 'text-gray-900'
  const textFaint = isDark ? 'text-white/40' : 'text-gray-500'
  const stepperInactive = isDark ? 'bg-[#1A1A1A]/85' : 'bg-black/10'

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
    } else {
      // First step → back arrow takes the user to the home page rather
      // than dead-ending. Matches user expectation that "Back" always
      // does something.
      navigate('/')
    }
  }, [state.step, navigate])

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
    setState(s => ({
      ...s,
      bootstrapResult: result,
      step: 'confirm',
      vaultPassword: '',
      vaultPasswordConfirm: '',
    }))
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
    <div className={`fixed inset-0 z-[100] overflow-y-auto overflow-x-hidden ${outerBg}`}>
      <BoidsBg isDark={isDark} />

      {/* Language picker — top-right, matches PostMintOnboarding */}
      <div className="absolute top-3 right-3 z-[110]">
        <LanguageSwitcher />
      </div>

      <div className="relative z-10 px-4 py-8 min-h-screen flex items-start justify-center">
        <div className="w-full max-w-lg">

          {/* Slim segmented stepper — hidden on the confirm success screen */}
          {showProgress && (
            <>
              {/* Back chevron inline above the stepper. Always present so
                  the user can always go back — on the first step it
                  navigates to home rather than the previous step. */}
              <button
                onClick={goBack}
                className={`mb-3 flex items-center gap-1 text-sm transition-colors cursor-pointer ${textFaint} hover:${textPrimary}`}
                aria-label={t('common.back')}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                <span>{t('common.back')}</span>
              </button>

              {/* Segmented stepper bar */}
              <div className="flex items-center justify-center gap-2 mb-6">
                {STEP_META.map((meta, i) => {
                  const done = i < progressIndex
                  const active = i === progressIndex
                  const label = stepLabel(meta.id, t)
                  return (
                    <button
                      key={meta.id}
                      onClick={() => {
                        if (i < progressIndex) {
                          // Only allow navigating back to completed steps
                          const targetStep = ALL_STEPS[i]
                          setState(s => ({ ...s, step: targetStep }))
                        }
                      }}
                      className={`flex-1 min-w-[56px] flex flex-col items-center gap-2 transition-opacity duration-300 ${
                        done && !active ? 'opacity-70 cursor-pointer hover:opacity-100' : active ? 'opacity-100 cursor-default' : 'opacity-50 cursor-default'
                      }`}
                    >
                      <div className={`w-full h-2 rounded-full transition-all duration-300 ${
                        done ? 'bg-green-500'
                        : active ? 'bg-yellow-500'
                        : stepperInactive
                      }`} />
                      <div className="flex items-center gap-1 whitespace-nowrap">
                        <span className={`transition-colors duration-300 ${
                          done ? 'text-green-400'
                          : active ? 'text-yellow-500'
                          : textFaint
                        }`}>
                          {done ? <HiCheck className="w-4 h-4" /> : meta.icon}
                        </span>
                        <span className={`text-sm font-medium transition-colors duration-300 ${
                          done ? 'text-green-400'
                          : active ? textPrimary
                          : textFaint
                        }`}>
                          <span className="min-[480px]:hidden">{meta.shortLabel}</span>
                          <span className="hidden min-[480px]:inline">{label}</span>
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {/* Step content */}
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

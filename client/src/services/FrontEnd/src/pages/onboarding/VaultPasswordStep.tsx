/**
 * VaultPasswordStep.tsx
 *
 * Step 3 of /onboarding: set the vault password that protects the user's
 * identity backup blob.
 *
 * Requirements:
 * - >= 12 characters
 * - Confirm field must match
 * - Strength meter (length + character type diversity)
 * - Prominent "ultimate authority" warning — we cannot recover this
 */

import { useState } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'

const MIN_LENGTH = 12

export interface VaultPasswordStepProps {
  vaultPassword: string
  vaultPasswordConfirm: string
  onPasswordChange: (value: string) => void
  onConfirmChange: (value: string) => void
  onNext: () => void
  onBack: () => void
}

// ─── Strength scoring ────────────────────────────────────────────────────────
//
// 0 = empty  |  1 = very weak  |  2 = weak  |  3 = fair  |  4 = strong
//
// Scoring factors:
//   +1 if >= 12 chars
//   +1 if >= 16 chars
//   +1 if contains lowercase
//   +1 if contains uppercase
//   +1 if contains digit
//   +1 if contains special character
//   Score clamped to 0–4.

interface StrengthResult {
  score: 0 | 1 | 2 | 3 | 4
  label: string
  colorClass: string
}

function scorePassword(pw: string): StrengthResult {
  if (pw.length === 0) return { score: 0, label: '', colorClass: '' }

  let pts = 0
  if (pw.length >= 12) pts++
  if (pw.length >= 16) pts++
  if (/[a-z]/.test(pw)) pts++
  if (/[A-Z]/.test(pw)) pts++
  if (/[0-9]/.test(pw)) pts++
  if (/[^a-zA-Z0-9]/.test(pw)) pts++

  // Map raw pts (0–6) to 4-step scale
  const score = (
    pts <= 1 ? 1
    : pts <= 2 ? 2
    : pts <= 4 ? 3
    : 4
  ) as 0 | 1 | 2 | 3 | 4

  // score is guaranteed 1–4 here (0 handled above by the early return)
  const s = score as 1 | 2 | 3 | 4
  const labels: Record<1 | 2 | 3 | 4, string> = {
    1: 'Very weak',
    2: 'Weak',
    3: 'Fair',
    4: 'Strong',
  }
  const colors: Record<1 | 2 | 3 | 4, string> = {
    1: 'text-red-500',
    2: 'text-orange-500',
    3: 'text-yellow-500',
    4: 'text-green-500',
  }
  const segColors: Record<1 | 2 | 3 | 4, string> = {
    1: 'bg-red-500',
    2: 'bg-orange-500',
    3: 'bg-yellow-500',
    4: 'bg-green-500',
  }

  return { score, label: labels[s], colorClass: colors[s] + ' ' + segColors[s] }
}

export default function VaultPasswordStep({
  vaultPassword,
  vaultPasswordConfirm,
  onPasswordChange,
  onConfirmChange,
  onNext,
  onBack,
}: VaultPasswordStepProps) {
  const { isDark } = useTheme()
  const t = useT()

  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  const strength = scorePassword(vaultPassword)
  const isTooShort = vaultPassword.length > 0 && vaultPassword.length < MIN_LENGTH
  const mismatch =
    vaultPasswordConfirm.length > 0 && vaultPassword !== vaultPasswordConfirm
  const canProceed =
    vaultPassword.length >= MIN_LENGTH && vaultPassword === vaultPasswordConfirm

  const mutedClass = isDark ? 'text-white/50' : 'text-gray-500'
  const strongClass = isDark ? 'text-white' : 'text-gray-900'
  const borderBase = isDark ? 'border-white/20' : 'border-gray-300'
  const borderFocus = 'focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500'
  const inputBg = isDark ? 'bg-white/5' : 'bg-white'

  // Strength bar — 4 segments
  const segmentFill = (idx: number) => {
    if (strength.score === 0) return false
    return idx < strength.score
  }
  const segColor = strength.score > 0
    ? ['bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-green-500'][strength.score - 1]
    : ''

  return (
    <div className="space-y-5">
      <div>
        <h2 className={`text-xl font-bold mb-1 ${strongClass}`}>
          {t('onboarding.vault.title')}
        </h2>
        <p className={`text-sm ${mutedClass}`}>
          {t('onboarding.vault.subtitle')}
        </p>
      </div>

      {/* Ultimate-authority warning */}
      <div className={`rounded-xl p-4 border ${isDark ? 'bg-red-500/10 border-red-500/30' : 'bg-red-50 border-red-200'}`}>
        <div className="flex gap-3">
          <svg className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div className="space-y-1">
            <p className={`text-sm font-semibold ${isDark ? 'text-red-400' : 'text-red-700'}`}>
              {t('onboarding.vault.warning_title')}
            </p>
            <p className={`text-sm ${isDark ? 'text-red-300/80' : 'text-red-600'}`}>
              {t('onboarding.vault.warning_body')}
            </p>
          </div>
        </div>
      </div>

      {/* Password input */}
      <div className="space-y-1">
        <label className={`block text-sm font-medium ${strongClass}`}>
          {t('onboarding.vault.password_label')}
        </label>
        <div className="relative">
          <input
            type={showPassword ? 'text' : 'password'}
            value={vaultPassword}
            onChange={e => onPasswordChange(e.target.value)}
            placeholder={t('onboarding.vault.password_placeholder')}
            autoComplete="new-password"
            className={`
              w-full px-4 py-3 pr-10 rounded-xl border text-sm transition-colors
              ${inputBg} ${strongClass} ${borderBase} ${borderFocus}
            `}
          />
          <button
            type="button"
            onClick={() => setShowPassword(v => !v)}
            className={`absolute right-3 top-1/2 -translate-y-1/2 ${mutedClass} hover:opacity-80 cursor-pointer`}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            )}
          </button>
        </div>

        {/* Strength bar */}
        {vaultPassword.length > 0 && (
          <div className="space-y-1 pt-1">
            <div className="flex gap-1">
              {[0, 1, 2, 3].map(idx => (
                <div
                  key={idx}
                  className={`h-1 flex-1 rounded-full transition-all duration-300 ${
                    segmentFill(idx) ? segColor : isDark ? 'bg-white/10' : 'bg-gray-200'
                  }`}
                />
              ))}
            </div>
            <p className={`text-xs ${strength.colorClass.split(' ')[0]}`}>
              {strength.label}
              {isTooShort && ` — ${t('onboarding.vault.min_length', { n: MIN_LENGTH })}`}
            </p>
          </div>
        )}
      </div>

      {/* Confirm input */}
      <div className="space-y-1">
        <label className={`block text-sm font-medium ${strongClass}`}>
          {t('onboarding.vault.confirm_label')}
        </label>
        <div className="relative">
          <input
            type={showConfirm ? 'text' : 'password'}
            value={vaultPasswordConfirm}
            onChange={e => onConfirmChange(e.target.value)}
            placeholder={t('onboarding.vault.confirm_placeholder')}
            autoComplete="new-password"
            className={`
              w-full px-4 py-3 pr-10 rounded-xl border text-sm transition-colors
              ${inputBg} ${strongClass}
              ${mismatch ? 'border-red-500' : borderBase}
              ${borderFocus}
            `}
          />
          <button
            type="button"
            onClick={() => setShowConfirm(v => !v)}
            className={`absolute right-3 top-1/2 -translate-y-1/2 ${mutedClass} hover:opacity-80 cursor-pointer`}
            aria-label={showConfirm ? 'Hide confirm password' : 'Show confirm password'}
          >
            {showConfirm ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            )}
          </button>
        </div>
        {mismatch && (
          <p className="text-xs text-red-500">
            {t('onboarding.vault.mismatch')}
          </p>
        )}
      </div>

      <div className="flex gap-3">
        <button
          onClick={onBack}
          className={`
            flex-1 py-3 rounded-full font-semibold text-sm transition-all border cursor-pointer
            ${isDark
              ? 'border-white/20 text-white/70 hover:bg-white/5'
              : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }
          `}
        >
          {t('common.back')}
        </button>
        <button
          onClick={onNext}
          disabled={!canProceed}
          className={`
            flex-1 py-3 rounded-full font-semibold text-sm transition-all
            ${canProceed
              ? 'bg-yellow-500 text-black hover:bg-yellow-400 cursor-pointer'
              : 'bg-yellow-500/30 text-black/40 cursor-not-allowed'
            }
          `}
        >
          {t('common.next')}
        </button>
      </div>
    </div>
  )
}

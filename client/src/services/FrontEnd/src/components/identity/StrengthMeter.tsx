/**
 * StrengthMeter.tsx
 *
 * Reusable password-strength indicator — extracted from VaultPasswordStep
 * so it can be shared by the identity dialogs (RotateEcdsaFallbackDialog,
 * ReDownloadBackupDialog) and the onboarding flow without duplication.
 *
 * Scoring factors:
 *   +1 if >= 12 chars
 *   +1 if >= 16 chars
 *   +1 if contains lowercase
 *   +1 if contains uppercase
 *   +1 if contains digit
 *   +1 if contains special character
 *   Score clamped to 0–4.
 */

import { useTheme } from '~/hooks/useTheme'

export const MIN_VAULT_PASSWORD_LENGTH = 12

export interface StrengthResult {
  score: 0 | 1 | 2 | 3 | 4
  label: string
  barColorClass: string
  textColorClass: string
}

export function scorePassword(pw: string): StrengthResult {
  if (pw.length === 0) {
    return { score: 0, label: '', barColorClass: '', textColorClass: '' }
  }

  let pts = 0
  if (pw.length >= 12) pts++
  if (pw.length >= 16) pts++
  if (/[a-z]/.test(pw)) pts++
  if (/[A-Z]/.test(pw)) pts++
  if (/[0-9]/.test(pw)) pts++
  if (/[^a-zA-Z0-9]/.test(pw)) pts++

  const score = (
    pts <= 1 ? 1
    : pts <= 2 ? 2
    : pts <= 4 ? 3
    : 4
  ) as 0 | 1 | 2 | 3 | 4

  const s = score as 1 | 2 | 3 | 4
  const labels: Record<1 | 2 | 3 | 4, string> = {
    1: 'Very weak',
    2: 'Weak',
    3: 'Fair',
    4: 'Strong',
  }
  const textColors: Record<1 | 2 | 3 | 4, string> = {
    1: 'text-red-500',
    2: 'text-orange-500',
    3: 'text-yellow-500',
    4: 'text-green-500',
  }
  const barColors: Record<1 | 2 | 3 | 4, string> = {
    1: 'bg-red-500',
    2: 'bg-orange-500',
    3: 'bg-yellow-500',
    4: 'bg-green-500',
  }

  return {
    score,
    label: labels[s],
    barColorClass: barColors[s],
    textColorClass: textColors[s],
  }
}

export interface StrengthMeterProps {
  password: string
  /** Show "minimum N chars" hint when below MIN_VAULT_PASSWORD_LENGTH */
  showMinHint?: boolean
}

/**
 * 4-segment strength bar + label. Renders nothing when `password` is empty.
 */
export function StrengthMeter({ password, showMinHint = true }: StrengthMeterProps): JSX.Element | null {
  const { isDark } = useTheme()

  if (password.length === 0) return null

  const strength = scorePassword(password)
  const isTooShort = password.length > 0 && password.length < MIN_VAULT_PASSWORD_LENGTH

  return (
    <div className="space-y-1 pt-1" data-testid="strength-meter">
      <div className="flex gap-1">
        {[0, 1, 2, 3].map(idx => (
          <div
            key={idx}
            className={`h-1 flex-1 rounded-full transition-all duration-300 ${
              strength.score > 0 && idx < strength.score
                ? strength.barColorClass
                : isDark ? 'bg-white/10' : 'bg-gray-200'
            }`}
          />
        ))}
      </div>
      <p className={`text-xs ${strength.textColorClass}`}>
        {strength.label}
        {showMinHint && isTooShort && ` — minimum ${MIN_VAULT_PASSWORD_LENGTH} characters`}
      </p>
    </div>
  )
}

export default StrengthMeter

/**
 * PasskeyStep.tsx
 *
 * Step 4 of /onboarding: enroll a WebAuthn passkey on this device.
 * Calls enrollPasskey() which triggers the browser's biometric prompt
 * (Face ID / Touch ID / Windows Hello). On success, passes the
 * PasskeyPubkey back to the parent via onNext so the backup step can
 * use it during bootstrapNewUser().
 *
 * On failure the error is shown inline with a Retry button.
 * The user cannot advance past this step without a successful passkey.
 */

import { useState } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { enrollPasskey, type PasskeyPubkey } from '~/services/identity/passkey'

export interface PasskeyStepProps {
  username: string
  onNext: (passkey: PasskeyPubkey) => void
  onBack: () => void
}

type Status = 'idle' | 'enrolling' | 'error'

export default function PasskeyStep({ username, onNext, onBack }: PasskeyStepProps) {
  const { isDark } = useTheme()
  const t = useT()

  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const mutedClass = isDark ? 'text-white/50' : 'text-gray-500'
  const strongClass = isDark ? 'text-white' : 'text-gray-900'

  const handleEnroll = async () => {
    setStatus('enrolling')
    setErrorMsg(null)

    try {
      const rpId = typeof window !== 'undefined' ? window.location.hostname : 'app.caw.social'
      const pubkey = await enrollPasskey({
        rpId,
        userName: username,
        userDisplayName: `@${username}`,
      })
      // Success — advance immediately with the pubkey
      onNext(pubkey)
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : t('onboarding.passkey.error_generic')
      setErrorMsg(msg)
      setStatus('error')
    }
  }

  const isEnrolling = status === 'enrolling'

  return (
    <div className="space-y-6">
      <div>
        <h2 className={`text-xl font-bold mb-1 ${strongClass}`}>
          {t('onboarding.passkey.title')}
        </h2>
        <p className={`text-sm ${mutedClass}`}>
          {t('onboarding.passkey.subtitle')}
        </p>
      </div>

      {/* Biometric icon */}
      <div className="flex justify-center py-4">
        <div className={`w-20 h-20 rounded-full flex items-center justify-center ${isDark ? 'bg-yellow-500/15' : 'bg-yellow-50'}`}>
          <svg className="w-10 h-10 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 11c0-1.657 1.343-3 3-3s3 1.343 3 3v1m-6 0V9a3 3 0 00-3-3H6a3 3 0 00-3 3v3m0 0v4a3 3 0 003 3h12a3 3 0 003-3v-4m-6-4V7m0 4V7m-6 4V7" />
          </svg>
        </div>
      </div>

      {/* Explanation */}
      <div className={`rounded-xl p-4 space-y-2 ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
        <p className={`text-sm font-medium ${strongClass}`}>
          {t('onboarding.passkey.how_it_works_title')}
        </p>
        <ul className={`text-sm space-y-1 ${mutedClass} list-disc list-inside`}>
          <li>{t('onboarding.passkey.how_1')}</li>
          <li>{t('onboarding.passkey.how_2')}</li>
          <li>{t('onboarding.passkey.how_3')}</li>
        </ul>
      </div>

      {/* Error message */}
      {status === 'error' && errorMsg && (
        <div className={`rounded-xl p-4 border ${isDark ? 'bg-red-500/10 border-red-500/30' : 'bg-red-50 border-red-200'}`}>
          <p className={`text-sm ${isDark ? 'text-red-400' : 'text-red-700'}`}>
            {errorMsg}
          </p>
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={onBack}
          disabled={isEnrolling}
          className={`
            flex-1 py-3 rounded-full font-semibold text-sm transition-all border
            ${isEnrolling ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
            ${isDark
              ? 'border-white/20 text-white/70 hover:bg-white/5'
              : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }
          `}
        >
          {t('common.back')}
        </button>
        <button
          onClick={handleEnroll}
          disabled={isEnrolling}
          className={`
            flex-1 py-3 rounded-full font-semibold text-sm transition-all
            ${isEnrolling
              ? 'bg-yellow-500/50 text-black/60 cursor-not-allowed'
              : 'bg-yellow-500 text-black hover:bg-yellow-400 cursor-pointer'
            }
          `}
        >
          {isEnrolling
            ? t('onboarding.passkey.enrolling')
            : status === 'error'
              ? t('common.try_again')
              : t('onboarding.passkey.cta')}
        </button>
      </div>
    </div>
  )
}

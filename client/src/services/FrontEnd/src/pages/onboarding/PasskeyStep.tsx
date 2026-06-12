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
import { setJSON } from '~/utils/safeStorage'
import { PASSKEY_CREDENTIAL_KEY, IDENTITY_KIND_KEY, IDENTITY_KIND_PASSKEY } from '~/constants/passkeyStorage'

export interface PasskeyStepProps {
  username: string
  onNext: (passkey: PasskeyPubkey) => void
  onBack: () => void
}

type Status = 'idle' | 'enrolling' | 'error'

/**
 * Humanizes the raw WebAuthn DOMException messages the browser throws.
 * Returns { text, learnMoreUrl? } so the UI can render the URL as a
 * proper hyperlink instead of pasting it inline in the body text.
 */
function humanizeWebAuthnError(raw: string): { text: string; learnMoreUrl?: string } {
  // Fall through to a friendly catch-all if the raw message is empty or
  // unhelpful. Chrome sometimes throws DOMExceptions with empty .message,
  // which would otherwise render an empty red error container.
  const GENERIC = "We couldn't create your passkey. Try again, and if it keeps failing make sure your device's biometrics are set up and you're on https (or localhost)."

  if (!raw || raw.trim() === '') {
    return { text: GENERIC }
  }
  // The browser throws `NotAllowedError: The operation either timed out
  // or was not allowed. See: https://www.w3.org/TR/webauthn-2/...`
  if (/timed out|was not allowed|NotAllowedError/i.test(raw)) {
    return {
      text: 'The passkey prompt was cancelled or timed out. Try again — when the prompt appears, accept it within a few seconds.',
      learnMoreUrl: 'https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client',
    }
  }
  if (/InvalidStateError/i.test(raw)) {
    return { text: 'A passkey for this account already exists on this device.' }
  }
  if (/SecurityError/i.test(raw)) {
    return { text: "This page can't create a passkey (the origin doesn't match the relying party). If you're on a fresh local dev server, try via https or localhost." }
  }
  if (/NotSupportedError/i.test(raw)) {
    return { text: "Your device or browser doesn't support passkeys yet." }
  }
  // Fallback: strip any trailing inline URL so it doesn't render as plain text.
  const stripped = raw.replace(/See:?\s+https?:\/\/\S+\.?/i, '').trim()
  return { text: stripped || GENERIC }
}

export default function PasskeyStep({ username, onNext, onBack }: PasskeyStepProps) {
  const { isDark } = useTheme()
  const t = useT()

  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState<{ text: string; learnMoreUrl?: string } | null>(null)

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
      // Persist the (non-secret) credentialId so a returning Pop-B user can
      // re-invoke signWithPasskey() on this device after onboarding. Without
      // this, IdentitySection / useRootSigner have no credentialId on reload
      // and fall back to the wallet-connect path. See project_root_signer.
      setJSON(PASSKEY_CREDENTIAL_KEY, pubkey.credentialId)
      // Mark this browser as a passkey (Population B) install so a returning
      // user with no wagmi wallet still classifies as 'B' in useWalletPopulation.
      setJSON(IDENTITY_KIND_KEY, IDENTITY_KIND_PASSKEY)
      // Success — advance immediately with the pubkey
      onNext(pubkey)
    } catch (err: unknown) {
      const raw =
        err instanceof Error ? err.message : t('onboarding.passkey.error_generic')
      setErrorMsg(humanizeWebAuthnError(raw))
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

      {/* Error message — text body, optional "Learn more" link rendered
          as a real hyperlink (not pasted inline). */}
      {status === 'error' && errorMsg && (
        <div className={`rounded-xl p-4 border ${isDark ? 'bg-red-500/10 border-red-500/30' : 'bg-red-50 border-red-200'}`}>
          <p className={`text-sm ${isDark ? 'text-red-400' : 'text-red-700'}`}>
            {errorMsg.text}
            {errorMsg.learnMoreUrl && (
              <>
                {' '}
                <a
                  href={errorMsg.learnMoreUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:opacity-80"
                >
                  Learn more
                </a>
              </>
            )}
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

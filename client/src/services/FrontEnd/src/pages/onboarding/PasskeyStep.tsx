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

import { useState, useMemo } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { enrollPasskey, type PasskeyPubkey } from '~/services/identity/passkey'
import { detectInAppBrowser } from '~/utils/inAppBrowser'

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
  const [copied, setCopied] = useState(false)

  // Detect embedded app webviews (Telegram, Instagram, etc.). These frequently
  // can't run passkey enrollment on iOS — warn before the user tries, and turn
  // a post-failure error into the "open in your browser" copy instead of the
  // misleading "prompt timed out" message.
  const inApp = useMemo(() => detectInAppBrowser(), [])

  const mutedClass = isDark ? 'text-white/50' : 'text-gray-500'
  const strongClass = isDark ? 'text-white' : 'text-gray-900'

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API can be blocked in some webviews; fail silently — the user
      // can still use the app's "open in browser" menu.
    }
  }

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
      // NOTE: the credentialId is NOT persisted here. At enroll time the account
      // doesn't exist yet — there's no tokenId or owner address to scope it by,
      // and the per-account keys require both. The credential is carried forward
      // in onboarding state (enrolledPasskey) and persisted at mint-complete in
      // Onboarding.tsx via persistPasskeyIdentity(mintedTokenId, ownerAddr, …),
      // where tokenId + owner are known. Nothing reads the credential between
      // enroll and mint (signing can't happen before the profile exists).
      onNext(pubkey)
    } catch (err: unknown) {
      const raw =
        err instanceof Error ? err.message : t('onboarding.passkey.error_generic')
      // In an embedded webview the failure is almost always "this environment
      // can't do WebAuthn", not a user timeout — surface the actionable copy.
      setErrorMsg(
        inApp.isInApp
          ? { text: t('onboarding.passkey.error_inapp') }
          : humanizeWebAuthnError(raw),
      )
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
        <ul className={`text-[13px] leading-snug space-y-1 ${mutedClass} list-disc list-inside`}>
          <li>{t('onboarding.passkey.how_1')}</li>
          <li>{t('onboarding.passkey.how_2')}</li>
          <li>{t('onboarding.passkey.how_3')}</li>
        </ul>
      </div>

      {/* In-app browser pre-flight warning. Shown before the user tries, so
          they can switch to Safari/Chrome instead of hitting a cryptic
          failure. Amber (caution), not red (error) — passkey hasn't failed
          yet, and on Android some webviews do work. */}
      {inApp.isInApp && status !== 'error' && (
        <div className={`rounded-xl p-4 border ${isDark ? 'bg-amber-500/10 border-amber-500/30' : 'bg-amber-50 border-amber-200'}`}>
          <p className={`text-sm font-medium mb-1 ${isDark ? 'text-amber-300' : 'text-amber-800'}`}>
            {t('onboarding.passkey.inapp_warning_title')}
          </p>
          <p className={`text-[13px] leading-snug ${isDark ? 'text-amber-200/80' : 'text-amber-700'}`}>
            {inApp.isIOS
              ? t('onboarding.passkey.inapp_warning_ios')
              : t('onboarding.passkey.inapp_warning_generic')}
          </p>
          <button
            onClick={handleCopyLink}
            className={`mt-2 text-[13px] font-medium underline hover:opacity-80 cursor-pointer ${isDark ? 'text-amber-300' : 'text-amber-800'}`}
          >
            {copied ? t('onboarding.passkey.inapp_copied') : t('onboarding.passkey.inapp_copy_link')}
          </button>
        </div>
      )}

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
          {inApp.isInApp && (
            <button
              onClick={handleCopyLink}
              className={`mt-2 text-[13px] font-medium underline hover:opacity-80 cursor-pointer ${isDark ? 'text-red-300' : 'text-red-700'}`}
            >
              {copied ? t('onboarding.passkey.inapp_copied') : t('onboarding.passkey.inapp_copy_link')}
            </button>
          )}
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
              ? (isDark ? 'bg-gray-700 text-gray-400 cursor-not-allowed' : 'bg-gray-300 text-gray-600 cursor-not-allowed')
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

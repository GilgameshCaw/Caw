/**
 * PasskeySignIn.tsx
 *
 * "Sign in with your passkey" for Population B users on a fresh device (or with
 * cleared localStorage). No invite code, no backup file — just the passkey
 * synced to the device's iCloud Keychain / Google Password Manager.
 *
 * Ceremony:
 *   1. User enters their username → resolve { tokenId } via /api/users/:username.
 *   2. POST /api/auth/verify-passkey/challenge { tokenId } → server-issued 32-byte
 *      challenge.
 *   3. signWithPasskeyDiscoverable(challenge) → WebAuthn assertion (the platform
 *      surfaces the synced passkey; no local credentialId needed).
 *   4. POST /api/auth/verify-passkey { tokenId, challenge, signature } → the
 *      server verifies the assertion on-chain (SmartEOA.isValidSignature) and
 *      issues a session.
 *   5. Persist the credentialId for next time, set the session + active token,
 *      navigate home.
 *
 * Security context: the server generates the challenge (never the client), so a
 * captured assertion can't be replayed. See passkeyVerify.ts.
 */

import { useState } from 'react'
import { useNavigate } from '~/utils/localizedRouter'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { usePasskeySignIn } from '~/hooks/usePasskeySignIn'

type Step = 'username' | 'signing' | 'success'

export default function PasskeySignIn() {
  const t = useT()
  const { isDark } = useTheme()
  const navigate = useNavigate()
  const { signIn, busy, error } = usePasskeySignIn()

  const [step, setStep] = useState<Step>('username')
  const [username, setUsername] = useState('')

  const handleSignIn = async () => {
    const uname = username.trim().toLowerCase()
    if (!uname) return
    setStep('signing')
    try {
      await signIn(uname)
      setStep('success')
      navigate('/home', { replace: true })
    } catch {
      // The hook surfaces a friendly `error`; return to the input step.
      setStep('username')
    }
  }

  const textClass = isDark ? 'text-white' : 'text-black'
  const mutedClass = isDark ? 'text-white/60' : 'text-gray-500'
  const cardClass = isDark ? 'bg-white/5 border border-white/10' : 'bg-white border border-gray-200 shadow-sm'
  const inputClass = isDark
    ? 'bg-white/5 border border-white/20 text-white placeholder-white/30 focus:border-yellow-500'
    : 'bg-gray-50 border border-gray-300 text-gray-900 placeholder-gray-400 focus:border-yellow-500'

  return (
    <div className={`min-h-screen flex flex-col items-center justify-center px-6 py-12 ${isDark ? 'bg-black' : 'bg-gray-50'}`}>
      <div className={`w-full max-w-md rounded-2xl p-8 ${cardClass}`}>
        {/* Back chevron — matches the Onboarding pattern. Returns to the
            previous page, falling back to home if there's no history. */}
        <button
          onClick={() => { if (window.history.length > 1) navigate(-1); else navigate('/') }}
          className={`mb-4 flex items-center gap-1 text-sm transition-colors cursor-pointer ${isDark ? 'text-white/50 hover:text-white/80' : 'text-gray-400 hover:text-gray-700'}`}
          aria-label={t('common.back')}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          <span>{t('common.back')}</span>
        </button>
        <div className="text-center mb-8">
          <div className={`w-14 h-14 mx-auto mb-4 rounded-full flex items-center justify-center ${isDark ? 'bg-yellow-500/20' : 'bg-yellow-100'}`}>
            <svg className="w-7 h-7 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 11V7a5 5 0 0110 0v4m-9 0h8a2 2 0 012 2v5a2 2 0 01-2 2H8a2 2 0 01-2-2v-5a2 2 0 012-2z" />
            </svg>
          </div>
          <h1 className={`text-2xl font-bold mb-2 ${textClass}`}>{t('passkey_signin.title')}</h1>
          <p className={`text-sm ${mutedClass}`}>{t('passkey_signin.subtitle')}</p>
        </div>

        {step !== 'success' && (
          <div className="space-y-4">
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value.toLowerCase())}
              onKeyDown={e => { if (e.key === 'Enter' && !busy) void handleSignIn() }}
              placeholder={t('passkey_signin.username_placeholder')}
              autoFocus
              autoComplete="username webauthn"
              disabled={busy}
              className={`w-full px-4 py-3 rounded-xl text-sm outline-none transition-colors ${inputClass}`}
            />
            {error && <p className="text-sm text-red-500 text-center">{error}</p>}
            <button
              onClick={() => void handleSignIn()}
              disabled={!username.trim() || busy}
              className="w-full py-3 rounded-xl font-bold text-sm bg-yellow-500 text-black hover:bg-yellow-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {busy ? t('passkey_signin.signing') : t('passkey_signin.cta')}
            </button>
            <button
              onClick={() => navigate('/recovery')}
              className={`w-full py-2.5 text-sm rounded-xl transition-colors cursor-pointer ${isDark ? 'text-white/50 hover:text-white/80' : 'text-gray-400 hover:text-gray-700'}`}
            >
              {t('passkey_signin.use_backup_instead')}
            </button>

            {/* New-user entry: a free sponsored account is available to anyone who
                verifies an X account (age >90d or verified). Routes into the
                onboarding flow's X gate. */}
            <div className={`pt-4 mt-2 border-t text-center ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
              <p className={`text-xs mb-2 ${mutedClass}`}>{t('passkey_signin.no_account')}</p>
              <button
                onClick={() => navigate('/onboarding?signup=x')}
                className={`w-full py-2.5 text-sm font-semibold rounded-xl transition-colors cursor-pointer ${isDark ? 'text-yellow-400 hover:text-yellow-300' : 'text-yellow-600 hover:text-yellow-700'}`}
              >
                {t('passkey_signin.create_with_x')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

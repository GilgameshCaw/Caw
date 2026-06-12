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
import { apiFetch, retryOnIndexing } from '~/api/client'
import { signWithPasskeyDiscoverable } from '~/services/identity/passkey'
import { useIdentitySigning } from '~/components/identity/IdentitySigningProvider'
import { useAuthStore } from '~/store/authStore'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { setJSON } from '~/utils/safeStorage'
import { PASSKEY_CREDENTIAL_KEY, IDENTITY_KIND_KEY, IDENTITY_KIND_PASSKEY } from '~/constants/passkeyStorage'
import type { TokenData } from '~/types'

type Step = 'username' | 'signing' | 'success'

export default function PasskeySignIn() {
  const t = useT()
  const { isDark } = useTheme()
  const navigate = useNavigate()
  const setSession = useAuthStore(s => s.setSession)
  const { startSigning, stopSigning } = useIdentitySigning()

  const [step, setStep] = useState<Step>('username')
  const [username, setUsername] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleSignIn = async () => {
    const uname = username.trim().toLowerCase()
    if (!uname) return
    setError(null)
    setBusy(true)
    setStep('signing')
    try {
      // 1. Resolve the profile.
      const profile = await apiFetch<{ tokenId: number; address: string }>(
        `/api/users/${encodeURIComponent(uname)}`,
      )
      if (!profile?.tokenId) {
        throw new Error(t('passkey_signin.error.not_found'))
      }

      // 2. Server-issued challenge.
      const { challenge } = await apiFetch<{ challenge: `0x${string}` }>(
        '/api/auth/verify-passkey/challenge',
        { method: 'POST', body: JSON.stringify({ tokenId: profile.tokenId }) },
      )

      // 3. Sign it with the device passkey (discoverable — no local credentialId).
      startSigning(t('passkey_signin.prompt'))
      let assertion
      try {
        const rpId = window.location.hostname
        assertion = await signWithPasskeyDiscoverable({ digest: challenge, rpId })
      } finally {
        stopSigning()
      }

      // 4. Verify on-chain + get a session (retry while the mint indexes).
      const data = await retryOnIndexing(() =>
        apiFetch<{
          sessionToken: string
          authorizedTokenIds: number[]
          authorizedAddresses: string[]
          expiresAt: number
        }>('/api/auth/verify-passkey', {
          method: 'POST',
          body: JSON.stringify({
            tokenId: profile.tokenId,
            challenge,
            signature: assertion.sig,
          }),
        }),
      )

      // 5. Persist identity for next time + set session + active token.
      setJSON(PASSKEY_CREDENTIAL_KEY, assertion.credentialId)
      setJSON(IDENTITY_KIND_KEY, IDENTITY_KIND_PASSKEY)
      setSession(data.sessionToken, data.authorizedTokenIds, data.authorizedAddresses, data.expiresAt)

      // Inject the profile so AuthGate sees an active token (Pop-B has no wagmi
      // wallet feeding tokenDataStore). Build a real-bigint TokenData (the API
      // row has no on-chain bigints — see Onboarding.tsx for the same pattern).
      const ownerAddr = (profile.address || data.authorizedAddresses[0]) as `0x${string}`
      const token: TokenData = {
        tokenId: profile.tokenId,
        username: uname,
        address: ownerAddr,
        owner: ownerAddr,
        withdrawable: 0n,
        ownerBalance: 0n,
        stakedAmount: 0n,
        cawonce: 0,
      }
      const tds = useTokenDataStore.getState()
      tds.setTokensForAddress(ownerAddr, [token])
      tds.setActiveTokenIdForAddress(ownerAddr, profile.tokenId)
      tds.setLastAddress(ownerAddr)

      setStep('success')
      navigate('/home', { replace: true })
    } catch (err: any) {
      const raw = err?.message || ''
      // WebAuthn DOMExceptions are user-cancellations most of the time; show a
      // friendly message rather than the raw exception.
      const isCancel = /NotAllowed|abort|cancel|denied/i.test(raw)
      setError(isCancel ? t('passkey_signin.error.cancelled') : (raw || t('passkey_signin.error.generic')))
      setStep('username')
    } finally {
      setBusy(false)
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
          </div>
        )}
      </div>
    </div>
  )
}

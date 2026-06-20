/**
 * usePasskeySignIn.ts
 *
 * Shared "sign in with an existing passkey" ceremony, extracted from
 * PasskeySignIn.tsx so it can run BOTH from the captive splash page AND inline
 * from AccountSettings (import another passkey profile without leaving the app).
 *
 * Ceremony (server generates the challenge, so a captured assertion can't be
 * replayed — see passkeyVerify.ts):
 *   1. Resolve { tokenId, address } via /api/users/:username.
 *   2. POST /api/auth/verify-passkey/challenge { tokenId } → 32-byte challenge.
 *   3. signWithPasskeyDiscoverable(challenge) → WebAuthn assertion.
 *   4. POST /api/auth/verify-passkey { tokenId, challenge, signature } → session.
 *   5. Persist credentialId + passkey-install flag, set session + active token,
 *      activate the owner in the session-key store (so an existing Quick Sign
 *      session is recognized — #240).
 *
 * Returns the resolved profile on success; the caller decides where to navigate
 * (the splash goes /home; AccountSettings stays put and lets the chooser update).
 */

import { useState, useCallback } from 'react'
import { apiFetch, retryOnIndexing } from '~/api/client'
import { signWithPasskeyDiscoverable } from '~/services/identity/passkey'
import { useIdentitySigning } from '~/components/identity/IdentitySigningProvider'
import { useAuthStore } from '~/store/authStore'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { setJSON } from '~/utils/safeStorage'
import { PASSKEY_CREDENTIAL_KEY, IDENTITY_KIND_KEY, IDENTITY_KIND_PASSKEY } from '~/constants/passkeyStorage'
import { useT } from '~/i18n/I18nProvider'
import type { TokenData } from '~/types'

export interface PasskeySignInResult {
  tokenId: number
  username: string
  address: `0x${string}`
}

export interface UsePasskeySignIn {
  /** Run the ceremony for `username`. Returns the profile on success, throws on failure. */
  signIn: (username: string) => Promise<PasskeySignInResult>
  busy: boolean
  /** User-friendly error message from the last attempt, or null. */
  error: string | null
  clearError: () => void
}

export function usePasskeySignIn(): UsePasskeySignIn {
  const t = useT()
  const setSession = useAuthStore(s => s.setSession)
  const { startSigning, stopSigning } = useIdentitySigning()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const signIn = useCallback(async (usernameRaw: string): Promise<PasskeySignInResult> => {
    const uname = usernameRaw.trim().toLowerCase()
    if (!uname) throw new Error(t('passkey_signin.error.generic'))
    setError(null)
    setBusy(true)
    try {
      // 1. Resolve the profile.
      const profile = await apiFetch<{ tokenId: number; address: string }>(
        `/api/users/${encodeURIComponent(uname)}`,
      )
      if (!profile?.tokenId) throw new Error(t('passkey_signin.error.not_found'))

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
          body: JSON.stringify({ tokenId: profile.tokenId, challenge, signature: assertion.sig }),
        }),
      )

      // 5. Persist identity + set session + inject the active token.
      setJSON(PASSKEY_CREDENTIAL_KEY, assertion.credentialId)
      setJSON(IDENTITY_KIND_KEY, IDENTITY_KIND_PASSKEY)
      setSession(data.sessionToken, data.authorizedTokenIds, data.authorizedAddresses, data.expiresAt)

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

      // Activate the owner so an existing Quick Sign session is recognized (#240).
      {
        const sk = useSessionKeyStore.getState()
        const ownerLc = ownerAddr.toLowerCase()
        sk.setActiveWallet(ownerLc)
        if (sk.sessions[ownerLc]) sk.setEnabled(true)
      }

      return { tokenId: profile.tokenId, username: uname, address: ownerAddr }
    } catch (err: any) {
      const raw = err?.message || ''
      const isCancel = /NotAllowed|abort|cancel|denied/i.test(raw)
      const msg = isCancel ? t('passkey_signin.error.cancelled') : (raw || t('passkey_signin.error.generic'))
      setError(msg)
      throw err
    } finally {
      setBusy(false)
    }
  }, [t, setSession, startSigning, stopSigning])

  return { signIn, busy, error, clearError: () => setError(null) }
}

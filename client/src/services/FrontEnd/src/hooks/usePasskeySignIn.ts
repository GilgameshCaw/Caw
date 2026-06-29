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
import { readContract } from '@wagmi/core'
import { baseSepolia } from 'wagmi/chains'
import { apiFetch, retryOnIndexing } from '~/api/client'
import { signWithPasskeyDiscoverable } from '~/services/identity/passkey'
import { useIdentitySigning } from '~/components/identity/IdentitySigningProvider'
import { useAuthStore } from '~/store/authStore'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { persistPasskeyIdentity } from '~/constants/passkeyStorage'
import { wagmiConfig } from '~/config/Web3Provider'
import { CAW_NAMES_L2_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileLedgerAbi } from '~/../../../abi/generated'
import { hasCachedKeyPair, deriveKeyPair } from '~/services/DmCryptoService'
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
      const profile = await apiFetch<{ tokenId: number; address: string; isPasskey?: boolean }>(
        `/api/users/${encodeURIComponent(uname)}`,
      )
      if (!profile?.tokenId) throw new Error(t('passkey_signin.error.not_found'))

      // Block Pop-A (plain wallet) accounts BEFORE the passkey prompt — they have
      // no passkey to sign with, so let them know up front instead of after a
      // confusing 401. isPasskey is server-computed (on-chain getCode); it
      // fail-opens to true on a server read error, so a real passkey user is
      // never wrongly blocked.
      if (profile.isPasskey === false) {
        throw new Error(t('passkey_signin.error.not_passkey'))
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
          body: JSON.stringify({ tokenId: profile.tokenId, challenge, signature: assertion.sig }),
        }),
      )

      // 5. Persist identity + set session + inject the active token.
      setSession(data.sessionToken, data.authorizedTokenIds, data.authorizedAddresses, data.expiresAt)

      const ownerAddr = (profile.address || data.authorizedAddresses[0]) as `0x${string}`
      // Per-account passkey identity: credential keyed by tokenId, the passkey
      // marker keyed by owner address (see passkeyStorage.ts).
      persistPasskeyIdentity(profile.tokenId, ownerAddr, assertion.credentialId)

      // Read the REAL staked CAW balance from the L2 ledger before we inject the
      // active token. The old code injected stakedAmount:0n and relied on a
      // later background refetch — but the very first action (e.g. follow) reads
      // the store synchronously and saw 0, throwing a false "insufficient CAW"
      // even when the account was funded via its invite. One direct read here
      // (~1s) closes that race: the gate in api/actions.ts:1034 sees the true
      // staked amount immediately. Non-fatal if it fails — fall back to 0n and
      // let the background refetch fill it in (old behavior).
      let stakedAmount = 0n
      let cawonce = 0
      try {
        const l2 = await readContract(wagmiConfig, {
          address: CAW_NAMES_L2_ADDRESS,
          chainId: baseSepolia.id,
          abi: cawProfileLedgerAbi,
          functionName: 'getTokens',
          args: [[profile.tokenId]],
        })
        const row = (l2 as readonly { tokenId: bigint; cawBalance: bigint; nextCawonce: bigint }[])
          .find(r => BigInt(r.tokenId) === BigInt(profile.tokenId))
        if (row) {
          stakedAmount = row.cawBalance ?? 0n
          cawonce = Number(row.nextCawonce ?? 0)
        }
      } catch {
        // L2 read failed — keep zeros; useTokenDataUpdate will refetch shortly.
      }

      const token: TokenData = {
        tokenId: profile.tokenId,
        username: uname,
        address: ownerAddr,
        owner: ownerAddr,
        withdrawable: 0n,
        ownerBalance: 0n,
        stakedAmount,
        cawonce,
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

      // Prime the DM key from this device's localStorage cache if it's there.
      // The DM key is SHA-256 over the secp256k1 recovery-key signature — a
      // passkey assertion can't reproduce it (WebAuthn is non-deterministic).
      // BUT on the device where the user onboarded, deriveKeyPair already
      // persisted the key to `caw-dm-keys`, so it restores with NO signature.
      // Without this prime, /messages showed "Enable DMs" and re-prompted for
      // the vault password even though the key was sitting in localStorage.
      // Fire-and-forget: a cache miss (new device / incognito) genuinely needs
      // the vault password, which /messages will then ask for — expected.
      void (async () => {
        try {
          if (!hasCachedKeyPair(profile.tokenId)) return
          // signer is never invoked on a cache hit (deriveKeyPair restores from
          // localStorage before requesting a signature) — pass a throwing stub.
          const noSigner = (): Promise<string> => {
            throw new Error('DM cache-prime should not need a signature')
          }
          const { publicKeyHex } = await deriveKeyPair(noSigner, profile.tokenId, uname)
          // Make sure the server still has the identity registered (idempotent).
          // No signature available here, so only re-assert via the public key —
          // if the server lacks it, /messages' fresh-setup path covers it.
          await apiFetch(`/api/dm/identity/${profile.tokenId}`).catch(() => null)
          console.log('[passkey-signin:dm] DM key cache-primed for tokenId', profile.tokenId, 'pub', publicKeyHex?.slice(0, 10))
        } catch {
          // Cache miss or restore failure — /messages handles the vault-password
          // path. Never fatal to sign-in.
        }
      })()

      return { tokenId: profile.tokenId, username: uname, address: ownerAddr }
    } catch (err: any) {
      const raw = err?.message || ''
      let msg: string
      if (/NotAllowed|abort|cancel|denied/i.test(raw)) {
        // User dismissed the passkey sheet.
        msg = t('passkey_signin.error.cancelled')
      } else if (/^API\s+404/i.test(raw) || /not\s*found/i.test(raw)) {
        // Username lookup miss.
        msg = t('passkey_signin.error.not_found')
      } else if (/^API\s+401/i.test(raw) || /unauthorized/i.test(raw)) {
        // verify-passkey rejected the assertion — the chosen passkey doesn't
        // belong to this account.
        msg = t('passkey_signin.error.wrong_passkey')
      } else {
        msg = raw && !/^API\s+\d+:/i.test(raw)
          ? raw
          : t('passkey_signin.error.generic')
      }
      setError(msg)
      throw err
    } finally {
      setBusy(false)
    }
  }, [t, setSession, startSigning, stopSigning])

  return { signIn, busy, error, clearError: () => setError(null) }
}

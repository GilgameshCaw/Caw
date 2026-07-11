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
import { buildPrfSalt, prfSecretToAesKey } from '~/services/identity/prf'
import { decryptBackupBlobWithKey, validatePrfBackupBlobShape } from '~/services/identity/backupBlob'
import { privateKeyToAccount } from 'viem/accounts'
import { useIdentitySigning } from '~/components/identity/IdentitySigningProvider'
import { useAuthStore } from '~/store/authStore'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { useRestoreRoamedSession, useWrapSessionForRoaming } from '~/hooks/useSessionKey'
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
  const restoreRoamedSession = useRestoreRoamedSession()
  const wrapSessionForRoaming = useWrapSessionForRoaming()
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
      // PIGGYBACK: request the PRF secret in this SAME touch (salt keyed by the
      // owner address, known from `profile.address` above) so the DM-unlock +
      // Quick-Sign-roam restores below can reuse it — no extra Face ID on a new
      // browser. The secret is captured into a closure var, never sent anywhere.
      startSigning(t('passkey_signin.prompt'))
      let assertion
      let signInPrfSecret: Uint8Array | undefined
      try {
        const rpId = window.location.hostname
        let signInPrfSalt: Uint8Array | undefined
        try { signInPrfSalt = await buildPrfSalt(profile.address) } catch { /* non-secure ctx */ }
        assertion = await signWithPasskeyDiscoverable({ digest: challenge, rpId, prfSalt: signInPrfSalt })
        signInPrfSecret = assertion.prfSecret
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
        if (sk.sessions[ownerLc]) {
          sk.setEnabled(true)
          // WRAP-ON-ACTIVATION: this browser HAS a local session, but a session
          // created before the roaming code (or otherwise never wrapped) has no
          // sessionPrfBlob on the server, so it can't roam to the NEXT browser.
          // Opportunistically wrap+upload it using the PRF secret captured in the
          // sign-in touch (no extra Face ID). No-op if it's already on the server.
          void wrapSessionForRoaming(ownerLc, signInPrfSecret).catch(() => {})
        } else {
          // ROAMING (Bug E): this browser has NO local Quick Sign session for the
          // account. If one was PRF-wrapped on another device, restore it now —
          // one Face ID unwraps the SAME on-chain-registered session key so QS
          // works here with no new registration tx. Fire-and-forget in the
          // background so it doesn't block the sign-in from returning; it enables
          // QS a moment later if a roamed session exists (else it's a silent
          // no-op — the user can create a fresh session normally).
          void (async () => {
            try {
              // Reuse the PRF secret captured in the sign-in touch (piggyback) so
              // this doesn't fire a second Face ID.
              const restored = await restoreRoamedSession(ownerLc, signInPrfSecret)
              if (restored) useSessionKeyStore.getState().setEnabled(true)
            } catch { /* non-fatal — user can create a fresh QS session */ }
          })()
        }
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
          // Cache miss or restore failure — the PRF restore below (or /messages'
          // vault-password path) covers it. Never fatal to sign-in.
        }
      })()

      // DM PRF restore (piggyback): on a NEW browser the localStorage cache above
      // misses, so unlock DMs by reusing the PRF secret CAPTURED in the sign-in
      // touch — no extra Face ID, no vault password. Fetch the DM prfBlob via the
      // session-authed retrieve, unwrap → recovery key → derive the DM key.
      // Fire-and-forget; on any failure /messages falls back to the password path.
      if (signInPrfSecret) void (async () => {
        let recoveryKey: Uint8Array | null = null
        try {
          if (hasCachedKeyPair(profile.tokenId)) return // already primed above
          const { prfBlob } = await apiFetch<{ prfBlob: string | null }>(
            '/api/wallet/blob/retrieve',
            { method: 'POST', body: JSON.stringify({ address: ownerAddr }) },
          )
          if (!prfBlob) return
          const parsed = JSON.parse(prfBlob)
          if (!validatePrfBackupBlobShape(parsed)) return
          const aesKey = await prfSecretToAesKey(signInPrfSecret)
          recoveryKey = await decryptBackupBlobWithKey(parsed, aesKey)
          let hex = '0x'
          for (let i = 0; i < recoveryKey.length; i++) hex += recoveryKey[i].toString(16).padStart(2, '0')
          const acct = privateKeyToAccount(hex as `0x${string}`)
          const dmSign = (m: string): Promise<string> => acct.signMessage({ message: m }).then(s => s as string)
          await deriveKeyPair(dmSign, profile.tokenId, uname)
          console.log('[passkey-signin:dm] DMs restored via PRF (no password) for tokenId', profile.tokenId)
        } catch {
          /* /messages vault-password path covers it */
        } finally {
          recoveryKey?.fill(0)
        }
      })()

      return { tokenId: profile.tokenId, username: uname, address: ownerAddr }
    } catch (err: any) {
      const raw = err?.message || ''
      const name = err?.name || ''
      let msg: string
      if (/NotSupported|SecurityError/i.test(name) || typeof navigator === 'undefined' || !navigator.credentials?.get) {
        // WebAuthn unavailable in this context (unsupported browser, insecure
        // origin, or missing platform authenticator).
        msg = t('passkey_signin.error.unsupported')
      } else if (/NotAllowed/i.test(name) || /NotAllowed|abort|cancel|denied|timed out or was not allowed/i.test(raw)) {
        // NotAllowedError: the user dismissed the passkey sheet OR the ceremony
        // timed out. Match on err.NAME (reliable) as well as the message, since
        // the raw W3C string ("The operation either timed out or was not
        // allowed…") does not contain the substring "NotAllowed".
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
  }, [t, setSession, startSigning, stopSigning, restoreRoamedSession, wrapSessionForRoaming])

  return { signIn, busy, error, clearError: () => setError(null) }
}

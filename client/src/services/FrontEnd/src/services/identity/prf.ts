/**
 * prf.ts — WebAuthn PRF (Pseudo-Random Function) extension helpers.
 *
 * The PRF extension lets a passkey deterministically derive a 32-byte secret
 * from a fixed salt during a normal `navigator.credentials.get()` biometric
 * ceremony. That secret is hardware-backed (never leaves the Secure Enclave /
 * TPM) and syncs with the passkey across the user's devices (iCloud Keychain /
 * Google Password Manager). We use it to WRAP the DM recovery key so a Face ID
 * prompt alone can unlock DMs — no vault password on supported browsers.
 *
 * Design (see native/docs/BROWSER_WALLET.md):
 *   Face ID  →  passkey derives prfSecret(salt)  →  HKDF  →  AES-GCM key
 *            →  encrypt/decrypt a copy of the secp256k1 recovery key.
 *
 * SECURITY:
 *   - The 32-byte PRF secret and the derived AES key NEVER leave the browser.
 *     Only the PRF-wrapped ciphertext + the (non-secret) salt may be persisted.
 *   - The salt is NOT a secret; PRF security comes from the authenticator
 *     gating the derivation behind user verification. We use a stable per-user
 *     salt so the same secret is reproducible across sessions and synced
 *     devices (a random salt would make the wrapped blob un-unwrappable).
 *   - Support is uneven (Chrome/Edge, Safari 17.4+/iOS, Firefox 119+,
 *     1Password/Bitwarden). Absent → callers fall back to the password path.
 */

import { requireSecureCrypto } from '~/utils/secureContext'
import { signWithPasskey } from './passkey'
import { getPasskeyCredential } from '~/constants/passkeyStorage'

// ─── Salt derivation ─────────────────────────────────────────────────────────

// Fixed app-level domain label mixed into every PRF salt so our salt can't
// collide with another relying party's PRF usage on the same credential.
const PRF_SALT_LABEL = 'caw-protocol/dm-recovery-key/prf/v1'

/**
 * Build the stable 32-byte PRF salt for a given owner address. Deterministic
 * and non-secret: `SHA-256(label || lowercased-owner-address)`. Mixing the
 * owner address keeps per-account salts distinct even on a shared authenticator
 * that holds multiple CAW passkeys.
 */
export async function buildPrfSalt(ownerAddress: string): Promise<Uint8Array> {
  requireSecureCrypto('PRF salt derivation')
  const material = new TextEncoder().encode(
    `${PRF_SALT_LABEL}:${ownerAddress.toLowerCase()}`,
  )
  const digest = await crypto.subtle.digest('SHA-256', material)
  return new Uint8Array(digest)
}

// ─── AES key from the PRF secret ─────────────────────────────────────────────

// HKDF info string — domain-separates the AES key from any other use of the
// same PRF secret.
const HKDF_INFO = new TextEncoder().encode('caw-dm-recovery-aes-gcm-256/v1')

/**
 * Turn a 32-byte PRF secret into a non-extractable AES-GCM-256 CryptoKey via
 * HKDF-SHA256. Shape matches vaultPassword.deriveKey's `.key` so backupBlob's
 * encrypt/decrypt can consume it interchangeably with the password-derived key.
 *
 * The PRF secret is already high-entropy; HKDF is used only for domain
 * separation + fixed output shaping, with an empty salt (RFC 5869 allows this
 * when the input keying material is already a uniformly random secret).
 */
export async function prfSecretToAesKey(prfSecret: Uint8Array): Promise<CryptoKey> {
  requireSecureCrypto('PRF key derivation')
  if (prfSecret.length !== 32) {
    throw new Error(`prfSecretToAesKey: expected 32-byte PRF secret, got ${prfSecret.length}`)
  }
  const ikm = await crypto.subtle.importKey('raw', prfSecret as BufferSource, 'HKDF', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: HKDF_INFO,
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable
    ['encrypt', 'decrypt'],
  )
}

// ─── Per-credential capability cache ─────────────────────────────────────────

// localStorage key prefix recording whether a credential has PROVEN it returns
// a PRF secret (a successful get() with a salt). This lets the unlock path
// pre-select "PRF" vs "password" without a wasted ceremony. Keyed by
// credentialId (base64url). The enroll-time `prf.enabled` hint is unreliable on
// some authenticators, so we only trust a real get() result here.
const PRF_CAP_PREFIX = 'caw:prf-capable:'

export function markPrfCapable(credentialId: string, capable: boolean): void {
  try {
    localStorage.setItem(PRF_CAP_PREFIX + credentialId, capable ? '1' : '0')
  } catch { /* storage unavailable → treat as unknown */ }
}

/**
 * Returns true only if this credential has previously returned a PRF secret.
 * `null`/absent means "unknown — try it and find out". A stored '0' means a
 * prior get() ran without a PRF result (authenticator doesn't support it).
 */
export function prfCapableForCredential(credentialId: string): boolean | null {
  try {
    const v = localStorage.getItem(PRF_CAP_PREFIX + credentialId)
    if (v === null) return null
    return v === '1'
  } catch {
    return null
  }
}

// ─── Support probe ───────────────────────────────────────────────────────────

/**
 * Static feasibility check: PRF requires a secure context + WebAuthn. This does
 * NOT prove the authenticator supports PRF (only a real get() with a salt can),
 * but it cheaply rules out environments where PRF can't work at all.
 */
export function isPrfEnvironmentSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext === true &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined'
  )
}

// ─── Phase-1 live probe (developer gate) ─────────────────────────────────────

export type PrfProbeResult = {
  environmentSupported: boolean
  credentialFound: boolean
  /** true iff the get() actually returned a 32-byte PRF secret. */
  prfSecretReturned: boolean
  /** first 8 hex chars of the derived secret, for a sanity eyeball. Never full. */
  secretPrefix?: string
  error?: string
}

/**
 * Run a REAL passkey ceremony against the active token's credential and report
 * whether this browser+authenticator returns a PRF secret. This is the Phase-1
 * viability gate — it does NOT persist or use the secret for anything; it only
 * proves PRF works on the user's actual stack before we build the crypto on it.
 *
 * Exposed as `window.__cawPrfProbe(tokenId, ownerAddress)` in dev/test builds.
 * Triggers ONE Face ID prompt. Safe: reads nothing sensitive, stores nothing.
 */
export async function probePrf(
  tokenId: number | string,
  ownerAddress: string,
): Promise<PrfProbeResult> {
  const environmentSupported = isPrfEnvironmentSupported()
  if (!environmentSupported) {
    return { environmentSupported, credentialFound: false, prfSecretReturned: false }
  }
  const credentialId = getPasskeyCredential(tokenId)
  if (!credentialId) {
    return { environmentSupported, credentialFound: false, prfSecretReturned: false,
      error: `no passkey credential stored for tokenId ${tokenId}` }
  }
  try {
    const salt = await buildPrfSalt(ownerAddress)
    const rpId = window.location.hostname
    // A throwaway 32-byte digest — the probe only cares about the PRF result,
    // not the signature.
    const digest = ('0x' + '11'.repeat(32)) as `0x${string}`
    const result = await signWithPasskey({ credentialId, digest, rpId, prfSalt: salt })
    const prfSecretReturned = !!result.prfSecret && result.prfSecret.length === 32
    markPrfCapable(credentialId, prfSecretReturned)
    return {
      environmentSupported,
      credentialFound: true,
      prfSecretReturned,
      secretPrefix: prfSecretReturned
        ? Array.from(result.prfSecret!.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join('')
        : undefined,
    }
  } catch (e) {
    return { environmentSupported, credentialFound: true, prfSecretReturned: false,
      error: e instanceof Error ? e.message : String(e) }
  }
}

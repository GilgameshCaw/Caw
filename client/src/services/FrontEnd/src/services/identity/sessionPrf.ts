/**
 * sessionPrf.ts — PRF-wrap / unwrap of a Quick Sign session so the on-chain
 * session key can ROAM to a new device via the passkey (Bug E).
 *
 * A Quick Sign session is a secp256k1 keypair REGISTERED ON-CHAIN (CawActions)
 * with a spend limit, scope, and expiry. On a new device there's no local key,
 * so today the user must create a NEW session (a fresh sponsored on-chain
 * registration tx). Instead we wrap the session's private key + metadata under
 * the passkey's WebAuthn PRF secret and store the ciphertext server-side. On a
 * new device: Face ID → PRF secret → unwrap → the SAME session key, whose
 * on-chain registration is still valid → zero-cost, instant roaming.
 *
 * SECURITY: the session private key is SPEND AUTHORITY (bounded by the on-chain
 * spend limit + scope). It is wrapped the same way as the DM recovery key
 * (AES-GCM under an HKDF-of-PRF-secret key) and NEVER leaves the browser in the
 * clear. Only the ciphertext + the non-secret salt-input (owner address) cross
 * the wire. Reuses the reviewed prf.ts + backupBlob.ts primitives.
 */

import { encryptBackupBlobWithKey, decryptBackupBlobWithKey, type PrfBackupBlob } from './backupBlob'
import { prfSecretToAesKey } from './prf'

// The session metadata we need to reconstruct a SessionKeyEntry on the new
// device. The private key itself is carried as the wrapped 32-byte secret; the
// rest is small non-secret metadata stored (encrypted, for integrity) in the
// same blob's associated data channel — but AES-GCM here encrypts only the 32
// private-key bytes (matching backupBlob), so the metadata rides ALONGSIDE the
// blob as a small plaintext JSON that we bind by re-checking against on-chain
// state at restore time (see useSessionKey restore path). Non-secret metadata:
export type SessionRoamMeta = {
  sessionAddress: `0x${string}`
  ownerAddress: string
  expiry: number
  scopeBitmap: number
  spendLimit?: string
  tipCeiling?: string
}

/**
 * Wrap a session private key (32 bytes) under the PRF secret → a PrfBackupBlob.
 * `pubkeyAddress` is set to the SESSION address (not the owner) so the new device
 * can sanity-check which key it unwrapped. The caller uploads this as
 * `sessionPrfBlob` and stores the SessionRoamMeta alongside.
 */
export async function wrapSessionKeyWithPrf(
  sessionPrivateKeyBytes: Uint8Array,
  prfSecret: Uint8Array,
  sessionAddress: `0x${string}`,
): Promise<PrfBackupBlob> {
  const aesKey = await prfSecretToAesKey(prfSecret)
  return encryptBackupBlobWithKey(sessionPrivateKeyBytes, aesKey, sessionAddress)
}

/**
 * Unwrap the session private key from a sessionPrfBlob using the PRF secret.
 * Returns the raw 32-byte session private key. Throws on tag mismatch (wrong
 * PRF secret / corrupted blob) → caller falls back to "create a new session".
 */
export async function unwrapSessionKeyWithPrf(
  blob: PrfBackupBlob,
  prfSecret: Uint8Array,
): Promise<Uint8Array> {
  const aesKey = await prfSecretToAesKey(prfSecret)
  return decryptBackupBlobWithKey(blob, aesKey)
}

// localStorage key for the non-secret roam metadata (sessionAddress + limits +
// expiry), keyed by owner address. The private key is NEVER here — only in the
// server-side PRF blob. This lets the new device rebuild the SessionKeyEntry
// after unwrapping the key; every field is ALSO re-verified against on-chain
// session state before the restored session is trusted for signing.
const SESSION_ROAM_META_PREFIX = 'caw:session-roam-meta:'

export function saveSessionRoamMeta(ownerAddress: string, meta: SessionRoamMeta): void {
  try {
    localStorage.setItem(SESSION_ROAM_META_PREFIX + ownerAddress.toLowerCase(), JSON.stringify(meta))
  } catch { /* storage unavailable → roaming just won't have local metadata; on-chain read fills it */ }
}

export function readSessionRoamMeta(ownerAddress: string): SessionRoamMeta | null {
  try {
    const raw = localStorage.getItem(SESSION_ROAM_META_PREFIX + ownerAddress.toLowerCase())
    return raw ? (JSON.parse(raw) as SessionRoamMeta) : null
  } catch { return null }
}

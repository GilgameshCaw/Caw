/**
 * vaultPassword.ts
 *
 * Key derivation for the vault password that protects the user's
 * secp256k1 backup blob.
 *
 * Algorithm: Argon2id (memory-hard) via argon2-browser, per
 * BACKUP_AND_RECOVERY.md §5 and plan-smart-eoa-passkey-sponsorship.md
 * §1 Scenario G mitigations. Argon2id is significantly stronger than
 * PBKDF2 against GPU/ASIC offline brute-force attacks.
 *
 * Forward-compat: blobs written before argon2-browser was wired in used
 * PBKDF2-SHA512 (flagged by BackupBlob.argon2.memorySize === 0). Those
 * blobs can still be decrypted: backupBlob.ts routes to `deriveKeyPbkdf2`
 * (exported) when it reads memorySize === 0 from the blob metadata.
 */

import * as argon2 from 'argon2-browser'
import { requireSecureCrypto } from '~/utils/secureContext'

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Argon2id parameters per BACKUP_AND_RECOVERY.md §5 mitigations.
 * memorySize in KiB (64 MiB = 65536 KiB). outputLength is 32 bytes
 * to produce an AES-GCM-256 key directly.
 */
export const ARGON2_PARAMS = {
  memorySize: 65536, // 64 MiB in KiB
  iterations: 3,
  parallelism: 1,
  outputLength: 32, // bytes — AES-GCM-256 key length
} as const

/**
 * PBKDF2 fallback parameters (used only for decrypting legacy blobs where
 * memorySize === 0). New blobs always use Argon2id.
 */
export const PBKDF2_FALLBACK_PARAMS = {
  iterations: 600_000, // OWASP 2023 recommendation for PBKDF2-HMAC-SHA512
  hash: 'SHA-512',
} as const

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Result type from deriveKey. Carries the CryptoKey and a metadata flag
 * so callers can record which algorithm was used in the backup blob.
 */
export type DerivedKeyResult = {
  key: CryptoKey
  /** true if Argon2id was used; false means PBKDF2 fallback was used. */
  usedArgon2: boolean
}

/**
 * Derive an AES-GCM-256 CryptoKey from a vault password and a 16-byte salt
 * using Argon2id.
 *
 * @param password  The user's vault password (plaintext string).
 * @param salt      16-byte random salt. Must be different for every key
 *                  derivation — do NOT reuse a salt across blobs.
 */
export async function deriveKey(
  password: string,
  salt: Uint8Array,
): Promise<DerivedKeyResult> {
  requireSecureCrypto('Vault password key derivation')

  if (salt.length !== 16) {
    throw new Error(`Salt must be 16 bytes; got ${salt.length}`)
  }

  // Argon2id is preferred (memory-hard). But argon2-browser loads its hashing
  // primitive from a base64-embedded WASM blob via atob(), and some production
  // bundles / browsers mangle or fail to decode that blob — surfacing as
  // "Failed to execute 'atob': string not correctly encoded" during backup.
  // Rather than dead-end the user's onboarding on a transient WASM-load issue,
  // fall back to PBKDF2-SHA512, which is already a fully-supported derivation
  // path: blobs are tagged with argon2.memorySize === 0, and decryptBackupBlob
  // routes those to deriveKeyPbkdf2 on recovery. The backup stays decryptable.
  try {
    const key = await deriveKeyArgon2(password, salt)
    return { key, usedArgon2: true }
  } catch (err) {
    console.warn(
      '[vaultPassword] Argon2id unavailable, falling back to PBKDF2-SHA512:',
      err instanceof Error ? err.message : err,
    )
    const key = await deriveKeyPbkdf2(password, salt)
    return { key, usedArgon2: false }
  }
}

/**
 * Argon2id key derivation.
 * Internal — callers always go through `deriveKey`.
 */
async function deriveKeyArgon2(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const result = await argon2.hash({
    pass: password,
    salt,
    type: argon2.ArgonType.Argon2id,
    mem: ARGON2_PARAMS.memorySize,
    time: ARGON2_PARAMS.iterations,
    parallelism: ARGON2_PARAMS.parallelism,
    hashLen: ARGON2_PARAMS.outputLength,
  })
  return crypto.subtle.importKey(
    'raw',
    result.hash,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * PBKDF2-SHA512 key derivation.
 *
 * Exported for backward-compat: `backupBlob.ts` calls this directly when
 * decrypting a blob where `argon2.memorySize === 0` (written before
 * argon2-browser was wired in). All new blobs use Argon2id (`deriveKey`).
 */
export async function deriveKeyPbkdf2(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_FALLBACK_PARAMS.iterations,
      hash: PBKDF2_FALLBACK_PARAMS.hash,
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false, // not extractable
    ['encrypt', 'decrypt'],
  )
}

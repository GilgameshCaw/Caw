/**
 * vaultPassword.ts
 *
 * Key derivation for the vault password that protects the user's
 * secp256k1 backup blob.
 *
 * Preferred algorithm: Argon2id (as specified in BACKUP_AND_RECOVERY.md §5
 * and plan-smart-eoa-passkey-sponsorship.md §1 Scenario G mitigations).
 * Argon2id is memory-hard and significantly stronger than PBKDF2 against
 * GPU/ASIC offline brute-force attacks.
 *
 * argon2-browser is NOT currently in package.json. This file ships a
 * PBKDF2-SHA512 fallback using the browser's native Web Crypto API and
 * documents the security gap explicitly. When argon2-browser is added as a
 * dependency, swap `deriveKey` to call `deriveKeyArgon2` instead.
 *
 * SECURITY NOTE — PBKDF2 vs Argon2id:
 *   PBKDF2-SHA512 is time-hard but NOT memory-hard. A GPU can parallelize
 *   many PBKDF2 attempts at low memory cost. Against a determined offline
 *   attacker with the backup blob, the effective security margin for a
 *   10-character password is many orders of magnitude weaker than Argon2id
 *   at the parameters below. The PBKDF2 fallback is acceptable for the
 *   browser build while argon2-browser is not yet wired in, but MUST be
 *   replaced before production launch. Track this in the pre-launch checklist
 *   (project_production_prep.md).
 *
 *   The gap is flagged in BackupBlob.argon2.memorySize: when memorySize === 0
 *   the blob was encrypted under PBKDF2, not Argon2id. The decrypt path
 *   checks this field and routes accordingly.
 *
 * Dependencies: Web Crypto (always available in secure contexts). No new
 * npm deps needed for the PBKDF2 path.
 */

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
 * PBKDF2 fallback parameters. High iteration count to slow down single-
 * threaded attack vectors, but NOT memory-hard. See security note above.
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
 * Derive an AES-GCM-256 CryptoKey from a vault password and a 16-byte salt.
 *
 * Currently routes to the PBKDF2 fallback because argon2-browser is not
 * installed. When argon2-browser is added to package.json, update this
 * function to call `deriveKeyArgon2` and set `usedArgon2: true`.
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

  // TODO: replace with Argon2id once argon2-browser is installed.
  // import argon2 from 'argon2-browser'
  // return deriveKeyArgon2(password, salt)
  const key = await deriveKeyPbkdf2(password, salt)
  return { key, usedArgon2: false }
}

/**
 * PBKDF2-SHA512 fallback implementation.
 * Internal — not exported; callers always go through `deriveKey`.
 */
async function deriveKeyPbkdf2(
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

/**
 * Argon2id key derivation stub.
 *
 * Uncomment and implement when argon2-browser is added to package.json:
 *
 *   import argon2 from 'argon2-browser'
 *
 *   async function deriveKeyArgon2(password: string, salt: Uint8Array): Promise<CryptoKey> {
 *     const result = await argon2.hash({
 *       pass: password,
 *       salt,
 *       type: argon2.ArgonType.Argon2id,
 *       mem: ARGON2_PARAMS.memorySize,
 *       time: ARGON2_PARAMS.iterations,
 *       parallelism: ARGON2_PARAMS.parallelism,
 *       hashLen: ARGON2_PARAMS.outputLength,
 *     })
 *     return crypto.subtle.importKey(
 *       'raw',
 *       result.hash,
 *       { name: 'AES-GCM' },
 *       false,
 *       ['encrypt', 'decrypt'],
 *     )
 *   }
 */

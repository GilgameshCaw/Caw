/**
 * backupBlob.ts
 *
 * Encrypted backup blob format for the user's secp256k1 private key.
 *
 * Format per native/docs/BACKUP_AND_RECOVERY.md — a JSON envelope that
 * can be stored in iCloud Drive, Google Drive App Folder, or downloaded
 * as a local file. The ciphertext is decryptable only by the vault
 * password (which derives the AES-GCM key via Argon2id or PBKDF2).
 *
 * Wire shape versioned at `version: 1`. Future format changes bump this
 * field and require a migration path before the old format is dropped.
 *
 * Crypto: AES-GCM-256 via Web Crypto `subtle.encrypt`. The key is
 * produced by `vaultPassword.ts`. The plaintext is the raw 32-byte
 * private key (not hex-encoded — 32 bytes flat).
 *
 * Hex encoding: all binary fields are `0x`-prefixed lowercase hex so the
 * blob is valid JSON and human-readable in a text editor.
 */

import { deriveKey, deriveKeyPbkdf2, ARGON2_PARAMS, type DerivedKeyResult } from './vaultPassword'
import { requireSecureCrypto } from '~/utils/secureContext'

// ─── Types ───────────────────────────────────────────────────────────────────

export type BackupBlob = {
  version: 1
  /**
   * KDF parameters recorded in the blob so the decrypt path knows how to
   * re-derive the AES key. When memorySize === 0 the blob was encrypted
   * under PBKDF2 (fallback path). When memorySize > 0 it was Argon2id.
   */
  argon2: {
    memorySize: number   // KiB; 0 means PBKDF2 fallback was used
    iterations: number
    parallelism: number
  }
  salt: `0x${string}`         // 16 bytes, hex
  iv: `0x${string}`           // 12 bytes, AES-GCM nonce, hex
  ciphertext: `0x${string}`   // encrypted 32-byte private key, hex
  pubkeyAddress: `0x${string}` // derived Ethereum address for verification
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  return ('0x' +
    Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')) as `0x${string}`
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) throw new Error('Odd hex length')
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Encrypt a secp256k1 private key under the user's vault password.
 *
 * Generates a fresh 16-byte salt and 12-byte AES-GCM IV each call —
 * NEVER reuse salt or IV. The blob is self-contained: it carries all
 * parameters needed to re-derive the key and decrypt.
 *
 * @param privateKey  Raw 32-byte private key bytes.
 * @param password    The user's vault password (plaintext).
 * @param address     The Ethereum address derived from this private key,
 *                    stored unencrypted so the user can confirm the correct
 *                    key is being restored without decrypting first.
 */
export async function encryptBackupBlob(
  privateKey: Uint8Array,
  password: string,
  address: `0x${string}`,
): Promise<BackupBlob> {
  requireSecureCrypto('Backup blob encryption')

  if (privateKey.length !== 32) {
    throw new Error(`Private key must be 32 bytes; got ${privateKey.length}`)
  }

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))

  const derivedResult: DerivedKeyResult = await deriveKey(password, salt)

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    derivedResult.key,
    privateKey,
  )
  const ciphertext = new Uint8Array(ciphertextBuffer)

  return {
    version: 1,
    argon2: derivedResult.usedArgon2
      ? {
          memorySize: ARGON2_PARAMS.memorySize,
          iterations: ARGON2_PARAMS.iterations,
          parallelism: ARGON2_PARAMS.parallelism,
        }
      : {
          // memorySize: 0 signals PBKDF2 fallback (see vaultPassword.ts note)
          memorySize: 0,
          iterations: 600_000,
          parallelism: 1,
        },
    salt: bytesToHex(salt),
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(ciphertext),
    pubkeyAddress: address,
  }
}

/**
 * Decrypt a backup blob back to the raw 32-byte private key.
 *
 * Throws `DOMException` (name 'OperationError') if the password is
 * wrong — Web Crypto AES-GCM authentication tag verification fails.
 * Callers should catch and surface "Incorrect vault password" to the user
 * rather than re-throwing the raw DOMException.
 *
 * @param blob      BackupBlob as returned by `encryptBackupBlob` or loaded
 *                  from a file.
 * @param password  The user's vault password (plaintext).
 * @returns         Raw 32-byte private key.
 */
export async function decryptBackupBlob(
  blob: BackupBlob,
  password: string,
): Promise<Uint8Array> {
  requireSecureCrypto('Backup blob decryption')

  if (blob.version !== 1) {
    throw new Error(
      `Unsupported blob version: ${(blob as { version: number }).version}. ` +
      `This version of the app can only decrypt version 1 blobs.`,
    )
  }

  const salt = hexToBytes(blob.salt)
  const iv = hexToBytes(blob.iv)
  const ciphertext = hexToBytes(blob.ciphertext)

  // Route to the correct KDF based on blob metadata.
  // memorySize === 0 means the blob was encrypted with PBKDF2 (written before
  // argon2-browser was wired in). memorySize > 0 means Argon2id was used.
  let aesKey: CryptoKey
  if (blob.argon2.memorySize === 0) {
    aesKey = await deriveKeyPbkdf2(password, salt)
  } else {
    const derivedResult = await deriveKey(password, salt)
    aesKey = derivedResult.key
  }

  let decryptedBuffer: ArrayBuffer
  try {
    decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      ciphertext,
    )
  } catch {
    // AES-GCM tag mismatch = wrong password (or corrupted blob).
    throw new Error('Incorrect vault password or corrupted backup blob.')
  }

  const privateKey = new Uint8Array(decryptedBuffer)

  if (privateKey.length !== 32) {
    throw new Error(
      `Decrypted payload is ${privateKey.length} bytes; expected 32. The blob may be corrupted.`,
    )
  }

  return privateKey
}

/**
 * Validate that a JavaScript object looks like a well-formed BackupBlob.
 *
 * Does NOT verify the password. Used when loading a blob from a file
 * to give the user a clear error before attempting decryption.
 */
export function validateBackupBlobShape(obj: unknown): obj is BackupBlob {
  if (typeof obj !== 'object' || obj === null) return false
  const b = obj as Record<string, unknown>
  if (b['version'] !== 1) return false
  if (typeof b['salt'] !== 'string' || !b['salt'].startsWith('0x')) return false
  if (typeof b['iv'] !== 'string' || !b['iv'].startsWith('0x')) return false
  if (typeof b['ciphertext'] !== 'string' || !b['ciphertext'].startsWith('0x')) return false
  if (typeof b['pubkeyAddress'] !== 'string' || !b['pubkeyAddress'].startsWith('0x')) return false
  if (typeof b['argon2'] !== 'object' || b['argon2'] === null) return false
  const a = b['argon2'] as Record<string, unknown>
  if (typeof a['memorySize'] !== 'number') return false
  if (typeof a['iterations'] !== 'number') return false
  if (typeof a['parallelism'] !== 'number') return false
  return true
}

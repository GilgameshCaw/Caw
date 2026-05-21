/**
 * secp256k1Key.ts
 *
 * Browser-side secp256k1 keypair generation and signing utilities for
 * Population B (phone-first, EIP-7702) users.
 *
 * The generated private key is the user's PRIMARY IDENTITY KEY — not a
 * throwaway. It becomes the `ecdsaFallback` address in SmartEOA and is the
 * last-resort recovery anchor that works independent of iCloud / Google
 * ecosystems. See plan-smart-eoa-passkey-sponsorship.md §4 and
 * native/docs/BACKUP_AND_RECOVERY.md for the full security model.
 *
 * Crypto primitives: viem (generatePrivateKey, privateKeyToAccount,
 * signMessage) and @noble/curves/secp256k1 for raw digest signing.
 * Both are already installed; no new dependencies needed.
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { secp256k1 } from '@noble/curves/secp256k1'
import { requireSecureCrypto } from '~/utils/secureContext'

// ─── Types ──────────────────────────────────────────────────────────────────

export type Secp256k1Keypair = {
  /** Raw 32-byte private key. Keep in memory only; do not log or persist in cleartext. */
  privateKey: Uint8Array
  /** Uncompressed public key: 0x04 || X (32 bytes) || Y (32 bytes) = 65 bytes total. */
  publicKey: `0x${string}`
  /** Ethereum address derived from the public key (EIP-55 checksum form). */
  address: `0x${string}`
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  return ('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate a new secp256k1 keypair using the browser's CSPRNG.
 *
 * Must be called in a secure context (HTTPS or localhost). Throws if
 * `crypto.subtle` is unavailable.
 */
export function generateSecp256k1Keypair(): Secp256k1Keypair {
  requireSecureCrypto('Identity key generation')

  // generatePrivateKey() uses crypto.getRandomValues internally.
  const privateKeyHex = generatePrivateKey() // `0x${string}` 32-byte hex
  const privateKeyBytes = hexToBytes(privateKeyHex)

  return keypairFromPrivateKey(privateKeyBytes)
}

/**
 * Restore a Secp256k1Keypair from raw private key bytes.
 *
 * Use this after decrypting a backup blob to re-derive the full keypair
 * without generating a new key.
 */
export function keypairFromPrivateKey(privateKey: Uint8Array): Secp256k1Keypair {
  if (privateKey.length !== 32) {
    throw new Error(`Invalid private key length: expected 32 bytes, got ${privateKey.length}`)
  }

  // privateKeyToAccount accepts a `0x${string}` 32-byte hex.
  const hexKey = bytesToHex(privateKey) as `0x${string}`
  const account = privateKeyToAccount(hexKey)

  // Derive uncompressed public key (0x04 prefix, 65 bytes).
  const uncompressedPubKey = secp256k1.getPublicKey(privateKey, false) // false = uncompressed

  return {
    privateKey,
    publicKey: bytesToHex(uncompressedPubKey),
    address: account.address,
  }
}

/**
 * Sign a 32-byte digest with the given private key.
 *
 * Returns canonical low-s (r, s, v) components. The `v` value is the
 * recovery bit (0 or 1), NOT the Ethereum legacy `v` (27/28). The caller
 * must add 27 when producing an Ethereum-compatible signature for on-chain
 * verification via `ecrecover`. SmartEOA's dispatch rule (§2 of the plan)
 * uses 65-byte `r || s || v` where v must be 27 or 28.
 *
 * If you need an on-chain-ready 65-byte blob, use `signDigestForOnChain`.
 */
export function signDigest(
  privateKey: Uint8Array,
  digest: `0x${string}`,
): { r: `0x${string}`; s: `0x${string}`; v: number } {
  const digestBytes = hexToBytes(digest)
  if (digestBytes.length !== 32) {
    throw new Error(`Digest must be 32 bytes; got ${digestBytes.length}`)
  }

  // noble/curves canonicalises s to low-s by default (lowS: true is the
  // default since @noble/curves 1.0). This is required by SmartEOA's
  // ecrecover path which rejects malleable signatures.
  const sig = secp256k1.sign(digestBytes, privateKey)
  const compact = sig.toCompactRawBytes() // 64 bytes: r[32] || s[32]

  return {
    r: bytesToHex(compact.slice(0, 32)),
    s: bytesToHex(compact.slice(32, 64)),
    v: sig.recovery ?? 0,
  }
}

/**
 * Sign a 32-byte digest and produce an Ethereum-compatible 65-byte sig blob
 * ready for SmartEOA's `isValidSignature` (65-byte dispatch path).
 *
 * Produces: `r[32] || s[32] || v[1]` where v is 27 or 28.
 */
export function signDigestForOnChain(
  privateKey: Uint8Array,
  digest: `0x${string}`,
): `0x${string}` {
  const { r, s, v } = signDigest(privateKey, digest)
  const rBytes = hexToBytes(r)
  const sBytes = hexToBytes(s)
  const out = new Uint8Array(65)
  out.set(rBytes, 0)
  out.set(sBytes, 32)
  out[64] = v + 27 // Ethereum-compatible: 27 or 28
  return bytesToHex(out)
}

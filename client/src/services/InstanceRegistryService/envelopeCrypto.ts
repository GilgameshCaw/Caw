// src/services/InstanceRegistryService/envelopeCrypto.ts
//
// Shared signing/verification primitives for cross-instance envelopes:
// the DM message relay (/api/dm/relay) and the DM-identity sync
// (/api/dm/identity/relay). Both flows use the same trust model —
// validator-key signs SHA-256(canonical envelope), receiver recovers
// the address and matches it against the source instance's registered
// validatorAddress in CawClientManager.
//
// Envelope canonicalization is INTENTIONALLY per-flow (kept inline
// in each route/service). The primitives below operate on the bytes
// the caller produces, so a future flow can pick its own canonical
// shape without touching this module.

import { secp256k1 } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16)
  }
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Sign a canonicalized envelope (string) with a 32-byte secp256k1 private
 * key. Returns 65-byte (r || s || v) hex prefixed with `0x`. The hash is
 * SHA-256 over the UTF-8 bytes of the canonical string — no eth-personal-
 * sign prefix, since these signatures never reach a wallet.
 */
export function signCanonical(canonical: string, privateKey: Uint8Array): string {
  const hash = sha256(new TextEncoder().encode(canonical))
  const sig = secp256k1.sign(hash, privateKey)
  const compact = sig.toCompactRawBytes()
  const v = (sig.recovery ?? 0) & 1
  const out = new Uint8Array(65)
  out.set(compact, 0)
  out[64] = v
  return '0x' + bytesToHex(out)
}

/**
 * Recover the signing address from a 65-byte (r || s || v) hex signature
 * over SHA-256(canonical). Returns lowercased `0x...` address. Throws on
 * malformed signature or recovery failure.
 */
export async function recoverAddressFromCanonical(
  canonical: string,
  signature: string,
): Promise<string> {
  const sigBytes = hexToBytes(signature)
  if (sigBytes.length !== 65) {
    throw new Error('Signature must be 65 bytes (r,s,v)')
  }
  const r = sigBytes.slice(0, 32)
  const s = sigBytes.slice(32, 64)
  const v = sigBytes[64]
  const hash = sha256(new TextEncoder().encode(canonical))
  const sigObj = secp256k1.Signature.fromCompact(new Uint8Array([...r, ...s])).addRecoveryBit(v % 2)
  const pubKey = sigObj.recoverPublicKey(hash).toRawBytes(false) // 65 bytes uncompressed
  const { keccak256 } = await import('ethers')
  const addrBytes = hexToBytes(keccak256(pubKey.slice(1))).slice(-20)
  return '0x' + Array.from(addrBytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

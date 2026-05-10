// Server-side verifier for the inner DM sender signature.
//
// The FE signs the canonical envelope below with the user's DmIdentity
// secp256k1 private key (which is itself wallet-derived). Receivers
// recover the address from the sig + canonical bytes and check it
// matches the wallet that owns senderId — closes the cross-instance
// forgery vector where any registered relay node could put words in
// any user's mouth.
//
// Canonicalization MUST match DmCryptoService.canonicalizeSenderEnvelope
// on the FE byte-for-byte; the field order below is the contract.
// Audit fix 2026-05-09 (Round 7 #1b).

import { keccak256, recoverAddress, toUtf8Bytes, getAddress } from 'ethers'
import { secp256k1 } from '@noble/curves/secp256k1'

export interface DmSenderEnvelope {
  encryptedPayload: string
  senderId: number
  recipientId: number
  conversationId: string
  contentType: string
  timestamp: number
}

export function canonicalizeDmSenderEnvelope(env: DmSenderEnvelope): string {
  return JSON.stringify({
    encryptedPayload: env.encryptedPayload,
    senderId:         env.senderId,
    recipientId:      env.recipientId,
    conversationId:   env.conversationId,
    contentType:      env.contentType,
    timestamp:        env.timestamp,
  })
}

/**
 * Recover the wallet-derived address that signed the envelope. Returns
 * the lowercased 0x-prefixed address. Throws on malformed sig.
 *
 * The signing path on the FE uses noble's secp256k1.sign() which produces
 * a (r,s,v=0|1) compact form where v is recovery {0,1}. We adapt v to
 * ethers' expected v={27,28} form so recoverAddress works.
 */
export function recoverDmSenderAddress(canonical: string, signature: string): string {
  const hash = keccak256(toUtf8Bytes(canonical))
  // ethers accepts {0,1} as a recovery byte too via v normalization,
  // but we normalize explicitly to {27,28} to match the SignatureLike
  // shape ethers prefers.
  let sig = signature
  if (sig.length === 132) {
    const last = sig.slice(-2)
    const v = parseInt(last, 16)
    if (v === 0 || v === 1) {
      sig = sig.slice(0, -2) + (v + 27).toString(16).padStart(2, '0')
    }
  }
  return recoverAddress(hash, sig).toLowerCase()
}

/**
 * Convenience: given the envelope + sig + the on-record DmIdentity
 * publicKey for senderId, return whether the sig recovers to the
 * address that the publicKey itself derives from. This is what we
 * actually want at receive time — `verifiedSender = true` iff the sig
 * came from the holder of senderId's registered DM keypair.
 *
 * Two-step verification (sig → address; publicKey → address; compare)
 * because the FE signs with its DmIdentity private key, and we trust
 * the publicKey-on-record was registered via wallet sig (DmIdentity
 * walletProof; see /api/dm/identity). If the publicKey was registered
 * fraudulently, this verification still binds messages to that bogus
 * publicKey — which is why DmIdentity.walletProof exists. Both checks
 * (sender sig + identity proof) stack: a forged message from a
 * fraudulent identity still gets `verifiedSender=true`, but the
 * identity itself is invalid and the receiver's identity-relay
 * verifier (/api/dm/identity/relay) refuses to accept it on cross-
 * instance sync.
 */
export function verifyDmSenderSig(
  envelope: DmSenderEnvelope,
  signature: string,
  publicKeyHex: string,
): boolean {
  if (!signature || !publicKeyHex) return false
  try {
    const recovered = recoverDmSenderAddress(canonicalizeDmSenderEnvelope(envelope), signature)
    const expected = addressFromCompressedPubkey(publicKeyHex)
    return recovered === expected
  } catch {
    return false
  }
}

/**
 * Derive an Ethereum address from a compressed secp256k1 public key
 * (33 bytes, hex-encoded). Matches the DmIdentity.publicKey shape that
 * DmCryptoService produces via secp256k1.getPublicKey(privKey, true).
 *
 * Returns lowercased 0x-prefixed address.
 */
export function addressFromCompressedPubkey(publicKeyHex: string): string {
  const clean = publicKeyHex.startsWith('0x') ? publicKeyHex.slice(2) : publicKeyHex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  // Decompress: noble's Point.fromHex on a 33-byte compressed key
  // returns the full point; we then take the uncompressed (64-byte)
  // (x || y) form and keccak it.
  const point = secp256k1.ProjectivePoint.fromHex(bytes)
  const uncompressed = point.toRawBytes(false) // 65 bytes, leading 0x04
  const xy = uncompressed.slice(1) // strip the 0x04 prefix
  const hash = keccak256(xy)
  // ethers' getAddress will checksum; we want lowercase for compare.
  return getAddress('0x' + hash.slice(-40)).toLowerCase()
}

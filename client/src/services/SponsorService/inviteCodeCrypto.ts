// services/SponsorService/inviteCodeCrypto.ts
//
// Symmetric encryption for the buyer's plaintext sponsor-invite code at rest.
// The plaintext code is a bearer secret (anyone holding it can redeem the
// gift), so we never store it raw — only AES-256-GCM ciphertext, decryptable by
// the server when the authenticated buyer asks for their code list.
//
// Key: INVITE_CODE_ENC_KEY env, a 32-byte key as 64 hex chars (or any string,
// which we hash to 32 bytes). Distinct from SPONSOR_CODE_HMAC_SECRET so a leak
// of one does not compromise the other.

import crypto from 'crypto'

const ALGO = 'aes-256-gcm'

/** Derive a stable 32-byte key from the env secret (hashed, so any length ok). */
function getKey(): Buffer {
  const raw = process.env.INVITE_CODE_ENC_KEY
  if (!raw || !raw.trim()) {
    throw new Error('INVITE_CODE_ENC_KEY is not set — cannot encrypt invite codes')
  }
  // sha256 always yields 32 bytes regardless of the source length/format.
  return crypto.createHash('sha256').update(raw.trim(), 'utf8').digest()
}

/** True when an encryption key is configured (so callers can gate cleanly). */
export function isInviteCodeCryptoConfigured(): boolean {
  const raw = process.env.INVITE_CODE_ENC_KEY
  return !!(raw && raw.trim())
}

/**
 * Encrypt a plaintext code. Returns "iv:tag:ciphertext" (all base64). The IV is
 * random per call so identical codes never produce identical ciphertext.
 */
export function encryptInviteCode(plaintext: string): string {
  const key = getKey()
  const iv = crypto.randomBytes(12) // 96-bit nonce, standard for GCM
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
}

/**
 * Decrypt an "iv:tag:ciphertext" envelope produced by encryptInviteCode().
 * Throws on a malformed envelope or a failed auth-tag check (tamper).
 */
export function decryptInviteCode(envelope: string): string {
  const key = getKey()
  const parts = envelope.split(':')
  if (parts.length !== 3) throw new Error('Malformed invite-code ciphertext envelope')
  const [ivB64, tagB64, ctB64] = parts
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const ct = Buffer.from(ctB64, 'base64')
  const decipher = crypto.createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

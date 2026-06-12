// api/routes/wallet-blob.ts
//
// Server-stored encrypted backup blob (#217, layered recovery). Stores ONLY the
// Argon2id-encrypted ciphertext envelope; the vault password is never sent to
// or stored by the server. Two layers of the recovery model live here:
//   - server copy (convenience): POST stores it, GET retrieves it gated by a
//     passkey assertion (the same on-chain verify as /api/auth/verify-passkey).
//   - email backstop (durable): POST can also email the ciphertext via Resend.
//
// The download copy is FE-only (a file save) and needs no server route.

import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { prisma } from '../../prismaClient'
import {
  issuePasskeyChallenge,
  consumePasskeyChallenge,
  verifyPasskeyAssertionOnChain,
} from '../util/passkeyVerify'
import {
  sendRecoveryBackupEmail,
  isMailerConfigured,
  isUsingSendmailFallback,
} from '../util/resendMailer'

const router = Router()

/**
 * Obfuscate an email for logs — keep the first char of the local part and the
 * domain, mask the rest: "alice@example.com" → "a***@example.com". The user
 * asked that we not store/expose their email; this keeps logs debuggable
 * (which domain bounced) without printing the full address. Never log the raw
 * string anywhere.
 */
function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return '***'
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  const head = local[0]
  return `${head}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`
}

const blobWriteLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many backup requests. Try again shortly.' },
})
const blobReadLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many backup retrieval attempts. Try again shortly.' },
})

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/

/**
 * POST /api/wallet/blob
 * Store (upsert) the encrypted backup blob for an owner address, and optionally
 * email it as the durable backstop. Body:
 *   { address, blob, email? }
 * `blob` is the BackupBlob JSON envelope (ciphertext only). No auth: the blob is
 * ciphertext and keyed by the owner's own address; storing it grants no access
 * (retrieval is passkey-gated). `username` is used only for the email copy text.
 */
router.post('/blob', blobWriteLimit, async (req, res) => {
  try {
    const { address, blob, email, username } = req.body || {}
    if (typeof address !== 'string' || !ADDR_RE.test(address)) {
      res.status(400).json({ error: 'Invalid address' })
      return
    }
    if (typeof blob !== 'string' || blob.length < 2 || blob.length > 100_000) {
      res.status(400).json({ error: 'Invalid blob' })
      return
    }
    // Sanity: must be JSON with a ciphertext field (don't store arbitrary data).
    try {
      const parsed = JSON.parse(blob)
      if (!parsed || typeof parsed.ciphertext !== 'string') {
        res.status(400).json({ error: 'Blob is not a valid encrypted backup envelope' })
        return
      }
    } catch {
      res.status(400).json({ error: 'Blob must be JSON' })
      return
    }

    const addr = address.toLowerCase()
    const emailStr = typeof email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
      ? email.trim()
      : null

    // We DO NOT persist the email. It is used transiently to send the backstop
    // and then discarded — "we don't store your email, it's only for backup".
    // WalletBlob.email is therefore always written null.
    await prisma.walletBlob.upsert({
      where: { address: addr },
      create: { address: addr, blob, email: null },
      update: { blob, email: null },
    })

    // Durable backstop: email the ciphertext if an email was provided and a mail
    // transport exists (Resend, or the opt-in local sendmail fallback). Non-fatal
    // — the server copy + download still exist. `usedFallback` tells the FE to
    // warn the user to check spam (bare-VPS mail often lands there). The email
    // address is only ever logged masked.
    // Sanitize username before it reaches the mailer: it ends up in the
    // attachment filename, which is written into a MIME Content-Disposition
    // header on the sendmail path. This route is unauthenticated, so an
    // unsanitized username could inject CRLF + extra headers (e.g. Bcc:) that
    // `sendmail -t` would honor. Restrict to the same charset the sponsor route
    // enforces on usernames; fall back to a safe literal otherwise.
    const safeUsername =
      typeof username === 'string' && /^[a-z0-9]{1,32}$/.test(username) ? username : 'there'

    let emailed = false
    let usedFallback = false
    if (emailStr && isMailerConfigured()) {
      const r = await sendRecoveryBackupEmail({
        to: emailStr,
        username: safeUsername,
        blobJson: blob,
      })
      emailed = r.ok
      usedFallback = r.ok && isUsingSendmailFallback()
      if (!r.ok) {
        console.warn(`[wallet-blob] recovery email to ${maskEmail(emailStr)} failed (non-fatal):`, r.error)
      }
    }

    res.json({ ok: true, emailed, usedFallback })
  } catch (error) {
    console.error('POST /api/wallet/blob error:', error)
    res.status(500).json({ error: 'Failed to store backup' })
  }
})

/**
 * POST /api/wallet/blob/challenge
 * Issue a server-generated challenge for passkey-gated blob retrieval. The blob
 * is keyed by address, but the passkey is enrolled at the owner SmartEOA — so
 * we challenge by tokenId (resolved from address) to reuse the verify-passkey
 * on-chain check. Body: { address }.
 */
router.post('/blob/challenge', blobReadLimit, async (req, res) => {
  try {
    const { address } = req.body || {}
    if (typeof address !== 'string' || !ADDR_RE.test(address)) {
      res.status(400).json({ error: 'Invalid address' })
      return
    }
    const user = await prisma.user.findFirst({
      where: { address: { equals: address, mode: 'insensitive' } },
      select: { tokenId: true },
    })
    if (!user) {
      res.status(404).json({ error: 'No profile for that address' })
      return
    }
    const challenge = await issuePasskeyChallenge(user.tokenId)
    res.json({ challenge })
  } catch (error) {
    console.error('POST /api/wallet/blob/challenge error:', error)
    res.status(500).json({ error: 'Failed to issue challenge' })
  }
})

/**
 * POST /api/wallet/blob/retrieve
 * Retrieve the stored blob, gated by a passkey assertion over the challenge.
 * Body: { address, challenge, signature }. Verifies the WebAuthn assertion
 * on-chain against the owner SmartEOA, then returns the ciphertext blob. The
 * client still needs the vault password to decrypt it.
 */
router.post('/blob/retrieve', blobReadLimit, async (req, res) => {
  try {
    const { address, challenge, signature } = req.body || {}
    if (typeof address !== 'string' || !ADDR_RE.test(address)) {
      res.status(400).json({ error: 'Invalid address' })
      return
    }
    if (typeof challenge !== 'string' || !HEX32_RE.test(challenge)) {
      res.status(400).json({ error: 'Invalid challenge' })
      return
    }
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      res.status(400).json({ error: 'Invalid signature' })
      return
    }

    const addr = address.toLowerCase()
    const user = await prisma.user.findFirst({
      where: { address: { equals: address, mode: 'insensitive' } },
      select: { tokenId: true, address: true },
    })
    if (!user) {
      res.status(404).json({ error: 'No profile for that address' })
      return
    }

    // Consume the challenge atomically (one-shot) before the on-chain call.
    const fresh = await consumePasskeyChallenge(user.tokenId, challenge)
    if (!fresh) {
      res.status(400).json({ error: 'Challenge expired or not found. Request a new one.' })
      return
    }

    let valid: boolean
    try {
      valid = await verifyPasskeyAssertionOnChain(user.address, challenge as `0x${string}`, signature as `0x${string}`)
    } catch (e) {
      console.error('[wallet-blob] on-chain verify failed (infra):', e)
      res.status(503).json({ error: 'Could not verify passkey right now. Please try again.' })
      return
    }
    if (!valid) {
      res.status(401).json({ error: 'Passkey signature did not validate for this account.' })
      return
    }

    const row = await prisma.walletBlob.findUnique({ where: { address: addr } })
    if (!row) {
      res.status(404).json({ error: 'No backup stored for this account.' })
      return
    }
    res.json({ blob: row.blob })
  } catch (error) {
    console.error('POST /api/wallet/blob/retrieve error:', error)
    res.status(500).json({ error: 'Failed to retrieve backup' })
  }
})

export default router

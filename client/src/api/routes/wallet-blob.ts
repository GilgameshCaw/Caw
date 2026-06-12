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
import { sendRecoveryBackupEmail, isMailerConfigured } from '../util/resendMailer'

const router = Router()

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

    await prisma.walletBlob.upsert({
      where: { address: addr },
      create: { address: addr, blob, email: emailStr },
      update: { blob, email: emailStr ?? undefined },
    })

    // Durable backstop: email the ciphertext if an email was provided and
    // Resend is configured. Non-fatal — the server copy + download still exist.
    let emailed = false
    if (emailStr && isMailerConfigured()) {
      const r = await sendRecoveryBackupEmail({
        to: emailStr,
        username: typeof username === 'string' && username ? username : 'there',
        blobJson: blob,
      })
      emailed = r.ok
      if (!r.ok) console.warn('[wallet-blob] recovery email failed (non-fatal):', r.error)
    }

    res.json({ ok: true, emailed, mailerConfigured: isMailerConfigured() })
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

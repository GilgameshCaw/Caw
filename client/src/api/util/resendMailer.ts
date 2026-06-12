// api/util/resendMailer.ts
//
// Minimal Resend transactional-email sender, called via the Resend REST API
// with fetch — no npm dependency. Env-gated on RESEND_KEY: if the key is
// absent the sender is a no-op (returns false), so the app runs fine without
// email configured.
//
// Used by the layered-recovery backstop (#217): we email the user their
// Argon2id-ENCRYPTED backup blob (ciphertext only — the vault password is never
// included, so the email provider can't read the key). The email is the durable
// copy that survives our server dying.

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

function getKey(): string | null {
  const k = process.env.RESEND_KEY
  return k && k.trim() ? k.trim() : null
}

/** True if Resend is configured (key present). */
export function isMailerConfigured(): boolean {
  return getKey() !== null
}

const FROM_ADDRESS = process.env.RESEND_FROM || 'CAW <recovery@caw.social>'

export interface SendEmailResult {
  ok: boolean
  id?: string
  error?: string
}

/**
 * Send an email via Resend. Returns { ok:false } (never throws) on any failure
 * — a backup-email failure must not break onboarding; the user still has the
 * download option.
 */
export async function sendEmail(opts: {
  to: string
  subject: string
  html: string
  text?: string
  attachments?: { filename: string; content: string /* base64 */ }[]
}): Promise<SendEmailResult> {
  const key = getKey()
  if (!key) return { ok: false, error: 'RESEND_KEY not configured' }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
        attachments: opts.attachments,
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `Resend HTTP ${res.status}: ${body.slice(0, 200)}` }
    }
    const data = await res.json().catch(() => ({}))
    return { ok: true, id: (data as any)?.id }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Resend request failed' }
  }
}

/**
 * Send the encrypted recovery blob as a durable backstop. The blob is ciphertext
 * — the recipient still needs their vault password to decrypt it, so emailing it
 * is safe (the mail provider can't read the key). Attached as a .json file the
 * user can re-import on /recovery.
 */
export async function sendRecoveryBackupEmail(opts: {
  to: string
  username: string
  blobJson: string
}): Promise<SendEmailResult> {
  const blobBase64 = Buffer.from(opts.blobJson, 'utf8').toString('base64')
  return sendEmail({
    to: opts.to,
    subject: 'Your CAW recovery file',
    html: [
      `<p>Hi @${opts.username},</p>`,
      `<p>Attached is your <strong>encrypted</strong> CAW recovery file. Keep this email — if you ever lose all your devices, you can use this file plus your vault password to recover your account.</p>`,
      `<p>This file is encrypted. It is useless to anyone without your vault password, which we never store and never send. Do not share your vault password with anyone.</p>`,
      `<p>To recover: open CAW, choose "Sign in with backup file", upload this file, and enter your vault password.</p>`,
    ].join('\n'),
    text:
      `Hi @${opts.username},\n\nAttached is your ENCRYPTED CAW recovery file. Keep this email — if you lose all your devices, use this file plus your vault password to recover your account. The file is useless without your vault password, which we never store. To recover: open CAW, choose "Sign in with backup file", upload this file, enter your vault password.`,
    attachments: [{ filename: `caw-recovery-${opts.username}.json`, content: blobBase64 }],
  })
}

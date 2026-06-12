// api/util/resendMailer.ts
//
// Transactional-email sender for the layered-recovery backstop (#217): we email
// the user their Argon2id-ENCRYPTED backup blob (ciphertext only — the vault
// password is never included, so the email provider can't read the key). The
// email is the durable copy that survives our server dying.
//
// Two transports, preferred in order:
//   1. Resend REST API (fetch, no npm dependency) when RESEND_KEY is set.
//   2. Local `sendmail` binary (Postfix/sendmail) as a dev/self-host fallback
//      when RESEND_KEY is absent — no npm dependency, no SMTP credentials. The
//      catch is deliverability (mail from a bare VPS often lands in spam), so
//      the UI tells the user to check their spam folder when this path is used.
// If neither is available the sender is a graceful no-op (returns false), so the
// app still runs with no email configured at all.

import { spawn } from 'child_process'

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

function getKey(): string | null {
  const k = process.env.RESEND_KEY
  return k && k.trim() ? k.trim() : null
}

/**
 * Which transport will actually be used, if any.
 *   'resend'   → RESEND_KEY present (best deliverability)
 *   'sendmail' → no key, but MAIL_FALLBACK_SENDMAIL=1 opts into local sendmail
 *   'none'     → no transport; sends are no-ops
 * sendmail is opt-in (not auto-on) so a misconfigured box doesn't silently
 * blackhole recovery emails into a non-existent local MTA.
 */
export function mailerTransport(): 'resend' | 'sendmail' | 'none' {
  if (getKey()) return 'resend'
  if (process.env.MAIL_FALLBACK_SENDMAIL === '1') return 'sendmail'
  return 'none'
}

/** True if SOME transport can send (Resend key or sendmail fallback). */
export function isMailerConfigured(): boolean {
  return mailerTransport() !== 'none'
}

/** True only when the deliverable-but-spammy local sendmail path is in use. */
export function isUsingSendmailFallback(): boolean {
  return mailerTransport() === 'sendmail'
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
  const transport = mailerTransport()
  if (transport === 'resend') return sendViaResend(getKey()!, opts)
  if (transport === 'sendmail') return sendViaSendmail(opts)
  return { ok: false, error: 'no mail transport configured' }
}

async function sendViaResend(
  key: string,
  opts: { to: string; subject: string; html: string; text?: string; attachments?: { filename: string; content: string }[] },
): Promise<SendEmailResult> {
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
 * Build a minimal MIME message and pipe it to the local `sendmail` binary. No
 * SMTP credentials, no npm dependency — relies on the host having a working
 * sendmail/Postfix. Multipart/mixed when there are attachments so the .json
 * recovery file rides along. Resolves { ok:false } (never throws) on any error.
 */
function sendViaSendmail(opts: {
  to: string
  subject: string
  html: string
  text?: string
  attachments?: { filename: string; content: string /* base64 */ }[]
}): Promise<SendEmailResult> {
  return new Promise(resolve => {
    try {
      const boundary = `caw_${Buffer.from(opts.subject).toString('hex').slice(0, 16)}_b`
      const lines: string[] = [
        `From: ${FROM_ADDRESS}`,
        `To: ${opts.to}`,
        `Subject: ${opts.subject}`,
        'MIME-Version: 1.0',
      ]
      const atts = opts.attachments ?? []
      if (atts.length === 0) {
        lines.push('Content-Type: text/html; charset=utf-8', '', opts.html)
      } else {
        lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '')
        lines.push(`--${boundary}`, 'Content-Type: text/html; charset=utf-8', '', opts.html, '')
        for (const a of atts) {
          // Defense-in-depth: never let a filename break out of the header line.
          // Callers should pass sanitized names, but strip CR/LF/quotes here so a
          // crafted filename can't inject extra MIME headers on the sendmail path.
          const safeName = a.filename.replace(/[\r\n"]/g, '')
          lines.push(
            `--${boundary}`,
            'Content-Type: application/json',
            'Content-Transfer-Encoding: base64',
            `Content-Disposition: attachment; filename="${safeName}"`,
            '',
            // a.content is already base64; wrap at 76 cols per RFC 2045.
            a.content.replace(/(.{76})/g, '$1\n'),
            '',
          )
        }
        lines.push(`--${boundary}--`, '')
      }
      const message = lines.join('\r\n')

      // -t reads recipients from the headers; -i prevents a lone "." truncating.
      const child = spawn('sendmail', ['-t', '-i'], { stdio: ['pipe', 'ignore', 'ignore'] })
      let settled = false
      const done = (r: SendEmailResult) => { if (!settled) { settled = true; resolve(r) } }
      child.on('error', e => done({ ok: false, error: `sendmail spawn failed: ${e?.message || e}` }))
      child.on('close', codeNum =>
        done(codeNum === 0 ? { ok: true } : { ok: false, error: `sendmail exited ${codeNum}` }),
      )
      child.stdin.on('error', () => { /* EPIPE if sendmail dies early — 'close' handles result */ })
      child.stdin.write(message)
      child.stdin.end()
    } catch (e: any) {
      resolve({ ok: false, error: e?.message || 'sendmail failed' })
    }
  })
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

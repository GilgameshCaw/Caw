import inquirer from 'inquirer'
import { section, dim, tipBlock, brand, success, warn } from '../utils/ui.js'

const DEFAULT_FROM = 'CAW <recovery@caw.social>'

/**
 * Optional step: configure the recovery-backup email transport.
 *
 * The app sends exactly ONE transactional email — the encrypted recovery
 * backup file (resendMailer.ts). Three possible outcomes here:
 *   • Resend   → writes RESEND_KEY + RESEND_FROM; clears MAIL_FALLBACK_SENDMAIL
 *   • Sendmail → writes MAIL_FALLBACK_SENDMAIL=1 + RESEND_FROM; prints setup guide
 *   • Skip     → writes nothing (email unavailable; download still works)
 *
 * Reads CAW_RESEND_KEY / CAW_MAIL_FALLBACK_SENDMAIL from --env preload to
 * skip the prompt on re-runs (same pattern as validator + infrastructure steps).
 *
 * Non-interactive (--yes) runs default to skip.
 */
export async function collectEmailConfig(nonInteractive = false) {
  section('Recovery-Backup Email (optional)')

  // --env preload: honour existing transport choice without re-prompting.
  const preloadResendKey  = process.env.CAW_RESEND_KEY || ''
  const preloadSendmail   = process.env.CAW_MAIL_FALLBACK_SENDMAIL || ''
  const preloadFrom       = process.env.CAW_RESEND_FROM || ''

  if (preloadResendKey) {
    const from = preloadFrom || DEFAULT_FROM
    console.log(dim('  Recovery-backup email: Resend transport loaded from --env preload.'))
    console.log(dim(`  From: ${from}`))
    return { resendKey: preloadResendKey, resendFrom: from, mailFallbackSendmail: false }
  }
  if (preloadSendmail === '1' || preloadSendmail === 'true') {
    const from = preloadFrom || DEFAULT_FROM
    console.log(dim('  Recovery-backup email: sendmail fallback loaded from --env preload.'))
    console.log(dim(`  From: ${from}`))
    return { resendKey: '', resendFrom: from, mailFallbackSendmail: true }
  }

  // Non-interactive: skip silently, let the operator configure later.
  if (nonInteractive) {
    console.log(dim('  Non-interactive run — skipping email setup. Set RESEND_KEY or MAIL_FALLBACK_SENDMAIL=1 in client/.env to enable later.'))
    return {}
  }

  tipBlock([
    'CAW sends ONE transactional email per user: the encrypted recovery backup',
    'file (ciphertext only — vault password never included). Users can always',
    'download the backup file directly. Email is a durable second copy.',
    '',
    `${dim('Skipping this step is safe — email can be configured in client/.env later.')}`,
  ])

  const { wantEmail } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'wantEmail',
      message: 'Set up recovery-backup email? (optional)',
      default: false,
    },
  ])

  if (!wantEmail) {
    console.log(dim('  Skipped. Email is unavailable — users can download their backup file instead.'))
    console.log(dim('  To enable later: set RESEND_KEY (Resend) or MAIL_FALLBACK_SENDMAIL=1 (Postfix) in client/.env.'))
    return {}
  }

  // Transport choice
  await new Promise(resolve => setTimeout(resolve, 50))
  const { transport } = await inquirer.prompt([
    {
      type: 'list',
      name: 'transport',
      message: 'Choose email transport:',
      choices: [
        { value: 'resend', name: `${brand('Resend')} ${dim('(recommended — hosted, best deliverability)')}` },
        { value: 'sendmail', name: `Self-host ${dim('(Postfix + sendmail binary on this VPS)')}` },
      ],
    },
  ])

  if (transport === 'resend') {
    return await collectResendConfig()
  } else {
    return await collectSendmailConfig()
  }
}

async function collectResendConfig() {
  console.log()
  tipBlock([
    `${brand('Resend domain verification — REQUIRED before sending.')}`,
    '',
    'The From domain must be verified in your Resend dashboard at',
    'resend.com/domains. Add the SPF + DKIM DNS records Resend provides.',
    'Without this, sends will fail with a 403 "domain is not verified" error.',
    '',
    `${dim('Your Resend API key is at resend.com/api-keys (create one with "Sending" access).')}`,
  ])

  const { resendKey } = await inquirer.prompt([
    {
      type: 'password',
      name: 'resendKey',
      message: 'Resend API key (re_...):',
      mask: '*',
      validate: (input) => {
        if (!input || !input.trim()) return 'Required'
        if (!input.trim().startsWith('re_')) return 'Resend keys start with re_'
        return true
      },
    },
  ])

  const { resendFrom } = await inquirer.prompt([
    {
      type: 'input',
      name: 'resendFrom',
      message: 'From address:',
      default: DEFAULT_FROM,
      validate: (input) => {
        if (!input || !input.trim()) return 'Required'
        return true
      },
    },
  ])

  const from = resendFrom.trim() || DEFAULT_FROM
  console.log()
  console.log(success('  Resend configured.'))
  console.log(dim(`  From: ${from}`))
  console.log(warn('  Reminder: verify the From domain at resend.com/domains before going live.'))
  console.log()

  return { resendKey: resendKey.trim(), resendFrom: from, mailFallbackSendmail: false }
}

async function collectSendmailConfig() {
  const { resendFrom } = await inquirer.prompt([
    {
      type: 'input',
      name: 'resendFrom',
      message: 'From address (RESEND_FROM):',
      default: DEFAULT_FROM,
      validate: (input) => {
        if (!input || !input.trim()) return 'Required'
        return true
      },
    },
  ])

  const from = resendFrom.trim() || DEFAULT_FROM

  console.log()
  console.log(success('  Sendmail fallback enabled (MAIL_FALLBACK_SENDMAIL=1).'))
  console.log()

  printSendmailGuide(from)

  return { resendKey: '', resendFrom: from, mailFallbackSendmail: true }
}

function printSendmailGuide(from) {
  const lines = [
    `${brand('━━ Self-hosted email setup guide ━━')}`,
    '',
    'The CLI can\'t run apt, edit DNS, or touch your VPS control panel.',
    'Complete these steps as the operator after the install finishes.',
    '',
    `${brand('1. Install Postfix + OpenDKIM')}`,
    '   sudo apt-get update && sudo apt-get install -y postfix opendkim opendkim-tools',
    '   When the Postfix installer prompts for "General type of mail configuration":',
    '     → choose "Internet Site"',
    '     → set "System mail name" to the domain in your From address',
    '   (Postfix installs the `sendmail` binary the app calls.)',
    '',
    `${brand('2. DNS records — ALL THREE = maximum deliverability')}`,
    `   ${warn('Fewer = more spam-foldering or outright dropped mail (esp. Gmail/Outlook).')}`,
    '',
    `   ${brand('A) SPF')} — authorize this server to send for your domain.`,
    '   Add a TXT record to the sending domain:',
    '     Name:  @ (or the domain itself)',
    '     Value: v=spf1 ip4:<SERVER_IP> ~all',
    '   Find your server IP with:',
    '     curl -s ifconfig.me',
    '',
    `   ${brand('B) DKIM')} — cryptographically sign outgoing mail.`,
    '   Generate a key (run as root or with sudo):',
    '     opendkim-genkey -b 2048 -d <your-domain> -s mail -D /etc/opendkim/keys/<your-domain>',
    '     chown -R opendkim:opendkim /etc/opendkim/keys',
    '   Publish the public key as a DNS TXT record:',
    '     Name:  mail._domainkey.<your-domain>',
    '     Value: (the contents of /etc/opendkim/keys/<your-domain>/mail.txt)',
    '   Then point OpenDKIM at Postfix — see:',
    '     https://www.digitalocean.com/community/tutorials/how-to-install-and-configure-dkim-with-postfix',
    '',
    `   ${brand('C) PTR / Reverse DNS')} — ${warn('single biggest factor for Gmail/Outlook acceptance.')}`,
    '   This is set in your VPS PROVIDER\'S control panel, NOT in your DNS:',
    '   The server\'s IP must reverse-resolve to a hostname on your sending domain.',
    '   Examples:',
    '     Hetzner: Server → Networking → Reverse DNS',
    '     DigitalOcean: Networking → Domains → Add PTR record (or via Droplet rename)',
    '     AWS EC2: Request a PTR record via the EC2 console (Elastic IPs → Actions)',
    '   Set it to the same hostname as Postfix\'s "myhostname" (e.g. mail.example.com).',
    '   This is the step most self-hosters skip — and the one that causes silent drops.',
    '',
    `${brand('3. Test it')}`,
    '   After setup: trigger a recovery-email send from the app (sign up → onboarding',
    '   → choose "email my backup file"), then check inbox AND spam folder.',
    `   From address will be: ${from}`,
    '',
    `${dim('For help: https://github.com/GilgameshCaw/Caw/issues')}`,
  ]

  for (const line of lines) {
    console.log(`  ${line}`)
  }
  console.log()
}

import crypto from 'crypto'
import inquirer from 'inquirer'
import { section, dim, tipBlock, brand, warn } from '../utils/ui.js'

/**
 * Collect sponsored-signup and Moonpay onramp configuration.
 *
 * Both are optional — operators can say "no" to both and get a working
 * install. Called after RPC URLs but before nginx config so the answers
 * land in fullConfig before generateConfig() writes the .env files.
 *
 * Returns an object merged into fullConfig:
 *   sponsorEnabled          — boolean
 *   sponsorCodeHmacSecret   — 32-byte hex string (auto-generated)
 *   sponsorWalletPrivateKey — string | ''
 *   sponsorMaxDepositCaw    — string | ''  (safety ceiling, e.g. '10000000')
 *   sponsorDefaultDepositCaw — string | '' (per-mint default, whole CAW ~$0.10)
 *   moonpayMode             — 'sandbox' | 'production' | 'disabled'
 *   moonpayApiKey           — string | ''  (publishable, goes in FE bundle)
 *   moonpayBaseUrl          — string | ''
 *   moonpaySecretKey        — string | ''  (backend-only, production only)
 *
 * --env preload: each collected value honors a CAW_* override so a
 * re-run after a failure skips the prompt automatically. See ENV_TO_CAW
 * in cli/bin/caw.js for the mapping.
 *
 * Node-type gate: sponsor codes are only meaningful when the node runs
 * the API (full / frontend-api / api-only). Moonpay is only meaningful
 * when the node bundles the frontend (full / frontend-api / frontend-only).
 * Both sections are still shown for 'full' and 'frontend-api', which cover
 * both sides. We skip silently for node types that don't need them.
 */
export async function collectOnboardingFeatures(nodeType, ctx = {}) {
  const runsApi = ['full', 'frontend-api', 'api-only'].includes(nodeType)
  const runsFrontend = ['full', 'frontend-api', 'frontend-only'].includes(nodeType)

  const sponsorResult = runsApi
    ? await collectSponsorConfig(ctx.validatorPrivateKey, ctx.infura)
    : { sponsorEnabled: false, sponsorCodeHmacSecret: '', sponsorWalletPrivateKey: '', sponsorMaxDepositCaw: '', sponsorDefaultDepositCaw: '' }

  const moonpayResult = runsFrontend
    ? await collectMoonpayConfig()
    : { moonpayMode: 'disabled', moonpayApiKey: '', moonpayBaseUrl: '', moonpaySecretKey: '' }

  // Stripe card checkout needs BOTH the API (secret + webhook) and the FE
  // (publishable key), so only offer it on a node that runs both.
  const runsApiAndFe = ['full', 'frontend-api'].includes(nodeType)
  const stripeResult = runsApiAndFe
    ? await collectStripeConfig()
    : { stripeEnabled: false, stripeSecretKey: '', stripeWebhookSecret: '', stripePublishableKey: '' }

  // Resend (recovery-email backstop) is API-side: the server emails users their
  // ENCRYPTED backup blob as a durable recovery copy. Only meaningful on a node
  // that runs the API.
  const resendResult = runsApi
    ? await collectRecoveryEmailConfig()
    : { resendKey: '' }

  return { ...sponsorResult, ...moonpayResult, ...stripeResult, ...resendResult }
}

// ---------------------------------------------------------------------------
// Recovery email (Resend)
// ---------------------------------------------------------------------------

async function collectRecoveryEmailConfig() {
  // --env preload: CAW_RESEND_KEY (from a prior run's RESEND_KEY) skips the prompt.
  const preload = process.env.CAW_RESEND_KEY || ''
  if (preload) {
    console.log(dim('  Using RESEND_KEY from --env preload.'))
    return { resendKey: preload }
  }

  section('Recovery email (Resend)')
  tipBlock([
    'Passkey (Population B) users get an encrypted recovery file at signup.',
    'With a Resend API key, the node can EMAIL that encrypted file to the user',
    'as a durable backstop — so if they lose every device they can still recover',
    'with the file + their vault password. The email only ever carries ciphertext;',
    'the vault password is never sent or stored.',
    '',
    'Optional. Without it, users still get the in-browser download + the',
    "passkey-gated server copy — they just don't get an emailed copy.",
    '',
    `${brand('Get a key:')} resend.com → API Keys. Free tier covers low volume.`,
  ])

  const { enableEmail } = await inquirer.prompt([
    {
      type: 'list',
      name: 'enableEmail',
      message: 'Email encrypted recovery files (Resend):',
      choices: [
        { value: false, name: `${dim('Disabled')} — no recovery emails (default)` },
        { value: true, name: `${brand('Enable')} — provide a Resend API key` },
      ],
      default: false,
    },
  ])

  if (!enableEmail) return { resendKey: '' }

  console.log()
  console.log(warn('  RESEND_KEY goes in client/.env (mode 0600).'))
  console.log(dim('  Optionally set RESEND_FROM (e.g. "CAW <recovery@yourdomain>") — defaults to a CAW sender.'))
  console.log()

  const { resendKey } = await inquirer.prompt([
    {
      type: 'password',
      name: 'resendKey',
      mask: '*',
      message: 'Resend API key (re_…):',
      validate: (v) => (v && v.trim().length > 0 ? true : 'Enter a key or Ctrl-C to skip'),
    },
  ])

  return { resendKey: resendKey.trim() }
}

// ---------------------------------------------------------------------------
// Sponsored signups
// ---------------------------------------------------------------------------

async function collectSponsorConfig(validatorPrivateKey = '', infura = null) {
  // --env preload: CAW_SPONSOR_ENABLED set to '1' means the previous run
  // had sponsor signups enabled. We still prompt for the wallet key (sensitive)
  // unless CAW_SPONSOR_WALLET_PRIVATE_KEY is also present.
  const preloadEnabled = process.env.CAW_SPONSOR_ENABLED === '1'

  // If neither preload var is set, ask interactively.
  if (!process.env.CAW_SPONSOR_ENABLED) {
    section('Sponsored signups')
    tipBlock([
      'Sponsored signups let users with no wallet create CAW profiles via',
      'invite codes you distribute. The sponsor wallet you provide pays L1 gas',
      "and the user's initial CAW deposit; per-code budget caps prevent abuse.",
      'Codes are managed via /api/admin/sponsor-codes (cookie-gated) or the',
      'client/scripts/create-sponsor-codes.ts CLI.',
      '',
      `${brand('Why this exists (the biometric / phone-first path):')}`,
      '  CAW supports "Population B" users — people who sign in with a device',
      '  passkey (Face ID / Touch ID / Windows Hello, via WebAuthn + EIP-7702)',
      '  instead of a browser wallet. They hold no ETH, so they cannot pay gas',
      '  to mint a profile or deposit CAW. The sponsor server signs and submits',
      "  those transactions on their behalf — that's what these codes fund.",
      '  Without sponsored signups, only users who already hold a funded wallet',
      '  (Population A) can onboard; the biometric/no-wallet flow is disabled.',
    ])

    const { sponsorChoice } = await inquirer.prompt([
      {
        type: 'list',
        name: 'sponsorChoice',
        message: 'Sponsored signups:',
        choices: [
          {
            value: 'disabled',
            name: `${dim('Disable')} — no sponsored onboarding (default; users must have own wallet)`,
          },
          {
            value: 'enabled',
            name: `${brand('Enable')} sponsored signups (requires a funded sponsor wallet)`,
          },
        ],
        default: 'disabled',
      },
    ])

    if (sponsorChoice === 'disabled') {
      return {
        sponsorEnabled: false,
        sponsorCodeHmacSecret: '',
        sponsorWalletPrivateKey: '',
        sponsorMaxDepositCaw: '',
        sponsorDefaultDepositCaw: '',
      }
    }
  } else if (!preloadEnabled) {
    // CAW_SPONSOR_ENABLED is set but to something other than '1' — treat as disabled.
    return {
      sponsorEnabled: false,
      sponsorCodeHmacSecret: '',
      sponsorWalletPrivateKey: '',
      sponsorMaxDepositCaw: '',
      sponsorDefaultDepositCaw: '',
    }
  }

  // Sponsor is enabled (either via preload or interactive choice).

  // HMAC secret: auto-generate if not preloaded. This value must persist
  // across re-runs — existing invite codes are HMAC-signed with it and
  // would break if it rotated. Honor the preload via CAW_SPONSOR_CODE_HMAC_SECRET.
  const hmacSecret =
    process.env.CAW_SPONSOR_CODE_HMAC_SECRET ||
    crypto.randomBytes(32).toString('hex')

  if (!process.env.CAW_SPONSOR_CODE_HMAC_SECRET) {
    console.log(dim('  Auto-generated SPONSOR_CODE_HMAC_SECRET (saved in client/.env — do not rotate).'))
  } else {
    console.log(dim('  Using SPONSOR_CODE_HMAC_SECRET from --env preload.'))
  }

  // Sponsor wallet private key — always prompted (sensitive; not preloaded
  // from --env to avoid silently re-committing a private key on re-runs).
  // Exception: CAW_SPONSOR_WALLET_PRIVATE_KEY set explicitly in shell env.
  let walletPrivateKey = process.env.CAW_SPONSOR_WALLET_PRIVATE_KEY || ''

  if (!walletPrivateKey) {
    console.log()
    console.log(warn('  The sponsor wallet private key will be written to client/.env (mode 0600).'))
    console.log(dim('  This key pays L1 gas and CAW deposits for every sponsored profile.'))
    console.log(dim('  Keep it funded but use a dedicated hot-wallet — not your main holdings.'))
    console.log()

    // Offer to reuse the validator key — same convenience option as the
    // archiver/replicator key. Only meaningful when we actually have a
    // validator key (full/validator nodes). Reuse is less isolated: the
    // sponsor wallet HOLDS funds (CAW + ETH), so a leak there is costlier
    // than the validator key alone — we recommend a separate hot-wallet,
    // but reuse is fine for testnet / low-budget setups.
    let keyChoice = 'import'
    if (validatorPrivateKey && /^0x[0-9a-fA-F]{64}$/.test(validatorPrivateKey)) {
      const ans = await inquirer.prompt([{
        type: 'list',
        name: 'keyChoice',
        message: 'Sponsor wallet key:',
        choices: [
          { value: 'import', name: `${brand('Use a dedicated sponsor wallet')} ${dim('(recommended — separate funds)')}` },
          { value: 'reuse', name: `${brand('Reuse the validator key')} ${dim('(simpler; the validator wallet then also holds sponsor funds)')}` },
        ],
        default: 'import',
      }])
      keyChoice = ans.keyChoice
    }

    if (keyChoice === 'reuse') {
      walletPrivateKey = validatorPrivateKey
      console.log(dim('  ✓ Sponsor wallet will reuse the validator key. Fund that address with CAW + ETH.'))
    } else {
      const { key } = await inquirer.prompt([
        {
          type: 'password',
          name: 'key',
          message: 'Sponsor wallet private key (0x-prefixed hex):',
          mask: '*',
          validate: (input) => {
            const v = input.trim()
            if (!v) return 'Required — the sponsor wallet must be able to sign and send L1 transactions'
            if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
              return 'Expected a 0x-prefixed 32-byte hex private key (66 chars total)'
            }
            return true
          },
        },
      ])
      walletPrivateKey = key.trim()
    }
  } else {
    console.log(dim('  Using SPONSOR_WALLET_PRIVATE_KEY from environment.'))
  }

  // ── Per-mint default deposit ──────────────────────────────────────────────
  // This is the CAW that funds EACH sponsored profile by default — the amount
  // a brand-new user starts with. $0.10 is a sensible starting gift: at the
  // current CAW price that's roughly enough for ~70 actions plus an 8-character
  // username. CAW has no fixed dollar value, so we read the LIVE mainnet price
  // (same Uniswap pool the running node uses) to convert the dollar target into
  // a CAW figure, and bake that CAW number into client/.env.
  //
  // Distinct from the MAX cap below: this is the *default funding amount*, the
  // cap is an upper *safety ceiling* on any single sponsored deposit.
  let defaultDepositCaw = process.env.CAW_SPONSOR_DEFAULT_DEPOSIT_CAW || ''

  if (!defaultDepositCaw && !process.env.CAW_SPONSOR_ENABLED) {
    const USD_TARGET = 0.10
    let suggestion = ''
    let priceNote = dim('  (could not read live CAW price — enter a CAW amount manually)')

    if (infura && infura.projectId) {
      const { ethers } = await import('ethers')
      const { fetchCawUsdPrice, usdToWholeCaw, mainnetUrlFromInfura } = await import('../utils/price.js')
      const mainnetUrl = mainnetUrlFromInfura(infura)
      const usdPerCaw = await fetchCawUsdPrice(ethers, mainnetUrl, infura.secret)
      if (usdPerCaw) {
        const whole = usdToWholeCaw(USD_TARGET, usdPerCaw)
        if (whole > 0n) {
          suggestion = whole.toString()
          priceNote = dim(`  Live price: 1 CAW ≈ $${usdPerCaw.toExponential(2)} → $${USD_TARGET.toFixed(2)} ≈ ${Number(whole).toLocaleString()} CAW`)
        }
      }
    }

    console.log()
    console.log(brand('  Default CAW deposit per sponsored profile'))
    console.log(dim(`  Funds each new profile. Target: ~$${USD_TARGET.toFixed(2)} (≈70 actions + an 8-char username).`))
    console.log(priceNote)

    const { defaultDeposit } = await inquirer.prompt([
      {
        type: 'input',
        name: 'defaultDeposit',
        message: `Default CAW deposit ${dim('(whole CAW; blank = use suggestion / server default)')}:`,
        default: suggestion,
        validate: (input) => {
          if (!input.trim()) return true
          const n = Number(input.trim())
          if (!Number.isFinite(n) || n <= 0) return 'Must be a positive number of whole CAW (e.g. 2600000)'
          return true
        },
      },
    ])
    // Stored as whole CAW; generate.js scales to wei when writing .env.
    defaultDepositCaw = defaultDeposit.trim()
  }

  // ── Max deposit cap (safety ceiling) ──────────────────────────────────────
  // Upper bound on ANY single sponsored deposit — a guard against a buggy/abused
  // caller draining the sponsor wallet, NOT the normal funding amount. Blank →
  // SponsorService's built-in 10M-CAW default.
  let maxDepositCaw = process.env.CAW_SPONSOR_MAX_DEPOSIT_CAW || ''

  if (!maxDepositCaw && !process.env.CAW_SPONSOR_ENABLED) {
    const { maxDeposit } = await inquirer.prompt([
      {
        type: 'input',
        name: 'maxDeposit',
        message: `Max CAW deposit per sponsored profile ${dim('(safety ceiling; blank = 10M CAW default)')}:`,
        default: '',
        validate: (input) => {
          if (!input.trim()) return true
          const n = Number(input.trim())
          if (!Number.isFinite(n) || n <= 0) return 'Must be a positive number (e.g. 10000000)'
          return true
        },
      },
    ])
    maxDepositCaw = maxDeposit.trim()
  }

  return {
    sponsorEnabled: true,
    sponsorCodeHmacSecret: hmacSecret,
    sponsorWalletPrivateKey: walletPrivateKey,
    sponsorMaxDepositCaw: maxDepositCaw,
    sponsorDefaultDepositCaw: defaultDepositCaw,
  }
}

// ---------------------------------------------------------------------------
// Moonpay card-payment onramp
// ---------------------------------------------------------------------------

async function collectMoonpayConfig() {
  // --env preload: VITE_MOONPAY_API_KEY in the frontend .env (or
  // CAW_MOONPAY_API_KEY in the shell) means Moonpay was configured last run.
  const preloadApiKey = process.env.CAW_MOONPAY_API_KEY || ''
  const preloadMode = process.env.CAW_MOONPAY_MODE || ''

  if (!preloadApiKey && !preloadMode) {
    section('Card-payment onboarding (Moonpay)')
    tipBlock([
      'Moonpay lets users buy ETH with a card / Apple Pay. CAW generates a',
      'fresh wallet for them in-browser and Moonpay handles the KYC + fiat.',
      '',
      'Sandbox (sandbox key, sandbox.moonpay.com): works immediately for dev/',
      'demo. No biz registration required, fake card numbers only.',
      '',
      'Production (live key, buy.moonpay.com): requires you to register a',
      'business entity with Moonpay (typical 1-3 week review). Real card',
      'transactions. https://www.moonpay.com/business/',
    ])

    const { moonpayChoice } = await inquirer.prompt([
      {
        type: 'list',
        name: 'moonpayChoice',
        message: 'Card-payment onboarding (Moonpay):',
        choices: [
          {
            value: 'disabled',
            name: `${dim('Disabled')} — no card-payment onboarding (default)`,
          },
          {
            value: 'sandbox',
            name: `${brand('Sandbox')} — test integration with fake card numbers (Recommended for dev)`,
          },
          {
            value: 'production',
            name: `${brand('Production')} — real card transactions (requires Moonpay biz registration)`,
          },
        ],
        default: 'disabled',
      },
    ])

    if (moonpayChoice === 'disabled') {
      return {
        moonpayMode: 'disabled',
        moonpayApiKey: '',
        moonpayBaseUrl: '',
        moonpaySecretKey: '',
      }
    }

    return collectMoonpayKeys(moonpayChoice)
  }

  // --env preload path: we have an API key from a previous run.
  if (preloadApiKey) {
    const mode = preloadMode || (preloadApiKey.startsWith('pk_test_') ? 'sandbox' : 'production')
    console.log(dim(`  Using VITE_MOONPAY_API_KEY from --env preload (mode: ${mode}).`))
    // Still need the secret key for production — prompt if not in env.
    const secretKey = await collectMoonpaySecretKey(mode)
    return {
      moonpayMode: mode,
      moonpayApiKey: preloadApiKey,
      moonpayBaseUrl: moonpayBaseUrlForMode(mode),
      moonpaySecretKey: secretKey,
    }
  }

  // CAW_MOONPAY_MODE was set but no key — treat as a fresh prompt for that mode.
  if (preloadMode && preloadMode !== 'disabled') {
    section('Card-payment onboarding (Moonpay)')
    console.log(dim(`  Mode ${preloadMode} preloaded — collecting API key.`))
    return collectMoonpayKeys(preloadMode)
  }

  // preloadMode === 'disabled'
  return {
    moonpayMode: 'disabled',
    moonpayApiKey: '',
    moonpayBaseUrl: '',
    moonpaySecretKey: '',
  }
}

async function collectMoonpayKeys(mode) {
  const { apiKey } = await inquirer.prompt([
    {
      type: 'input',
      name: 'apiKey',
      message: `Moonpay publishable API key ${dim('(starts with pk_test_ or pk_live_)')}:`,
      validate: (input) => {
        const v = input.trim()
        if (!v) return 'Required — paste your Moonpay publishable key'
        if (mode === 'sandbox' && !v.startsWith('pk_test_')) {
          return 'Sandbox keys start with pk_test_ — check your Moonpay dashboard'
        }
        if (mode === 'production' && !v.startsWith('pk_live_')) {
          return 'Production keys start with pk_live_ — check your Moonpay dashboard'
        }
        return true
      },
    },
  ])

  const secretKey = await collectMoonpaySecretKey(mode)

  return {
    moonpayMode: mode,
    moonpayApiKey: apiKey.trim(),
    moonpayBaseUrl: moonpayBaseUrlForMode(mode),
    moonpaySecretKey: secretKey,
  }
}

async function collectMoonpaySecretKey(mode) {
  if (mode !== 'production') return ''

  const fromEnv = process.env.CAW_MOONPAY_SECRET_KEY || ''
  if (fromEnv) {
    console.log(dim('  Using MOONPAY_SECRET_KEY from environment.'))
    return fromEnv
  }

  console.log()
  console.log(warn('  Production Moonpay requires a secret key for URL signing.'))
  console.log(dim('  Without it, Moonpay rejects purchase widget requests.'))
  console.log(dim('  The secret key is backend-only — it goes in client/.env (mode 0600), never the FE bundle.'))
  console.log()

  const { secretKey } = await inquirer.prompt([
    {
      type: 'password',
      name: 'secretKey',
      message: 'Moonpay secret key (sk_live_...):',
      mask: '*',
      validate: (input) => {
        const v = input.trim()
        if (!v) return 'Required for production — paste your Moonpay secret key (sk_live_...)'
        if (!v.startsWith('sk_live_')) {
          return 'Production secret keys start with sk_live_ — check your Moonpay dashboard'
        }
        return true
      },
    },
  ])

  return secretKey.trim()
}

function moonpayBaseUrlForMode(mode) {
  if (mode === 'sandbox') return 'https://buy-sandbox.moonpay.com'
  if (mode === 'production') return 'https://buy.moonpay.com'
  return ''
}

// ---------------------------------------------------------------------------
// Stripe card checkout (pay-with-card → webhook mints the profile)
// ---------------------------------------------------------------------------

async function collectStripeConfig() {
  // --env preload: STRIPE_SECRET_KEY in the backend .env (or CAW_STRIPE_SECRET_KEY
  // in the shell) means Stripe was configured last run.
  const preloadSecret = process.env.CAW_STRIPE_SECRET_KEY || ''

  if (preloadSecret) {
    console.log(dim('  Using STRIPE_SECRET_KEY from --env preload.'))
    return {
      stripeEnabled: true,
      stripeSecretKey: preloadSecret,
      stripeWebhookSecret: process.env.CAW_STRIPE_WEBHOOK_SECRET || '',
      stripePublishableKey: process.env.CAW_STRIPE_PUBLISHABLE_KEY || '',
    }
  }

  section('Card checkout (Stripe)')
  tipBlock([
    'Stripe card checkout lets a user pay with a card for a username + CAW',
    'deposit. They land on Stripe\'s hosted page; a webhook then mints the',
    'profile to a fresh wallet. The preferred fiat path (Moonpay is the',
    'older alternative).',
    '',
    `${brand('⚠  Untested:')} this flow is wired in code but has NOT been`,
    'end-to-end tested on a live Stripe account yet. Enable it only if you',
    'can verify the checkout → webhook → mint path yourself.',
    '',
    `${brand('⚠  Legal / KYC:')} taking card payments for crypto-adjacent value`,
    'is regulated. To defend the "stored-value, not a crypto on-ramp" framing,',
    'card-funded profiles should be minted with a WITHDRAW GATE — set a',
    'kycLevel at sponsored-mint time so the deposit is locked (180-day',
    'time-lock at level 1, or KYC-at-withdraw at level 2+). Without a gate,',
    'a Stripe-funded mint looks like an unlicensed fiat-to-crypto exchange in',
    'most jurisdictions. See docs/CARD_PROFILE_AND_KYC_PLAN.md + whitepaper',
    '§6.11. This is the operator\'s legal call — the CLI does not set it for you.',
  ])

  const { stripeChoice } = await inquirer.prompt([
    {
      type: 'list',
      name: 'stripeChoice',
      message: 'Card checkout (Stripe):',
      choices: [
        { value: 'disabled', name: `${dim('Disabled')} — no card checkout (default)` },
        { value: 'enabled', name: `${brand('Enable')} Stripe card checkout (untested; you accept the KYC/legal responsibility)` },
      ],
      default: 'disabled',
    },
  ])

  if (stripeChoice === 'disabled') {
    return { stripeEnabled: false, stripeSecretKey: '', stripeWebhookSecret: '', stripePublishableKey: '' }
  }

  console.log()
  console.log(warn('  STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET go in client/.env (mode 0600).'))
  console.log(dim('  Get these from your Stripe dashboard → Developers → API keys / Webhooks.'))
  console.log(dim('  Use test keys (sk_test_… / whsec_… / pk_test_…) until you\'ve verified the flow.'))
  console.log()

  const { secretKey } = await inquirer.prompt([{
    type: 'password',
    name: 'secretKey',
    message: 'Stripe secret key (sk_test_… or sk_live_…):',
    mask: '*',
    validate: (input) => /^sk_(test|live)_/.test(input.trim()) ? true : 'Expected a Stripe secret key starting with sk_test_ or sk_live_',
  }])

  const { webhookSecret } = await inquirer.prompt([{
    type: 'password',
    name: 'webhookSecret',
    message: 'Stripe webhook signing secret (whsec_…):',
    mask: '*',
    validate: (input) => /^whsec_/.test(input.trim()) ? true : 'Expected a webhook signing secret starting with whsec_ (Stripe → Webhooks → your endpoint)',
  }])

  const { publishableKey } = await inquirer.prompt([{
    type: 'input',
    name: 'publishableKey',
    message: 'Stripe publishable key (pk_test_… or pk_live_… — shipped in the FE bundle):',
    validate: (input) => /^pk_(test|live)_/.test(input.trim()) ? true : 'Expected a Stripe publishable key starting with pk_test_ or pk_live_',
  }])

  return {
    stripeEnabled: true,
    stripeSecretKey: secretKey.trim(),
    stripeWebhookSecret: webhookSecret.trim(),
    stripePublishableKey: publishableKey.trim(),
  }
}

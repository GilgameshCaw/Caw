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
 *   sponsorMaxDepositCaw    — string | ''  (optional cap, e.g. '1000')
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
    ? await collectSponsorConfig(ctx.validatorPrivateKey)
    : { sponsorEnabled: false, sponsorCodeHmacSecret: '', sponsorWalletPrivateKey: '', sponsorMaxDepositCaw: '' }

  const moonpayResult = runsFrontend
    ? await collectMoonpayConfig()
    : { moonpayMode: 'disabled', moonpayApiKey: '', moonpayBaseUrl: '', moonpaySecretKey: '' }

  return { ...sponsorResult, ...moonpayResult }
}

// ---------------------------------------------------------------------------
// Sponsored signups
// ---------------------------------------------------------------------------

async function collectSponsorConfig(validatorPrivateKey = '') {
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
      }
    }
  } else if (!preloadEnabled) {
    // CAW_SPONSOR_ENABLED is set but to something other than '1' — treat as disabled.
    return {
      sponsorEnabled: false,
      sponsorCodeHmacSecret: '',
      sponsorWalletPrivateKey: '',
      sponsorMaxDepositCaw: '',
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

  // Optional per-code CAW deposit cap. Unset → SponsorService uses its
  // hardcoded default (not prompted unless CAW_SPONSOR_MAX_DEPOSIT_CAW is absent).
  let maxDepositCaw = process.env.CAW_SPONSOR_MAX_DEPOSIT_CAW || ''

  if (!maxDepositCaw && !process.env.CAW_SPONSOR_ENABLED) {
    // Only ask when we're doing this interactively (not on a preloaded re-run).
    const { maxDeposit } = await inquirer.prompt([
      {
        type: 'input',
        name: 'maxDeposit',
        message: `Max CAW deposit per sponsored profile ${dim('(leave blank for server default)')}:`,
        default: '',
        validate: (input) => {
          if (!input.trim()) return true
          const n = Number(input.trim())
          if (!Number.isFinite(n) || n <= 0) return 'Must be a positive number (e.g. 1000)'
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

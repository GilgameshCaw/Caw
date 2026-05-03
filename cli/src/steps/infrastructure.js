import inquirer from 'inquirer'
import { execSync, spawnSync } from 'child_process'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { section, dim, tipBlock, brand, success, warn } from '../utils/ui.js'
import { createClientFlow, lookupClientStorageChain } from './clientCreator.js'
import { pickClientAndApi } from './clientAndApiPicker.js'

/**
 * Phase 1 of infra collection: domain + admin password + client selection
 * + WalletConnect ID. These run BEFORE the L2 RPC step so the L2 prompt
 * can name the actual storage chain (Base Sepolia / Arbitrum Sepolia / …)
 * once we know which client the operator picked.
 *
 * Returns:
 *   • domain, adminPassword          — for nodes that serve HTTP
 *   • clientId, storageChain         — { key, label, eid } or null when
 *                                       lookup fails / public client
 *   • walletConnectProjectId
 *
 * The remaining infra config (DB / Redis / ES / docker mode / API port)
 * is collected by collectInfraLate() AFTER the L2 RPC step.
 */
export async function collectInfraEarly(nodeType, ctx = {}) {
  if (nodeType === 'frontend-only') {
    return collectFrontendOnlyConfig(ctx)
  }

  const result = {}

  // Domain (for nodes that serve HTTP). install.sh asks for the domain
  // before cloning and exports it as CAW_DOMAIN. When set, take it as
  // gospel — re-asking is friction. The only case we prompt is when the
  // Node CLI is run standalone (without install.sh), e.g. local dev.
  let domain = process.env.CAW_DOMAIN || ''
  let adminPassword = ''

  if (['full', 'frontend-api', 'api-only'].includes(nodeType) && !domain) {
    section('Domain & Access')

    const { hasDomain } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'hasDomain',
        message: 'Do you have a domain name for this node?',
        default: false,
      },
    ])

    if (hasDomain) {
      const { domainInput } = await inquirer.prompt([
        {
          type: 'input',
          name: 'domainInput',
          message: 'Domain name (e.g., caw.example.com):',
          validate: (input) => /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(input) ? true : 'Enter a valid domain',
        },
      ])
      domain = domainInput
    } else {
      console.log(dim('  You can set up a domain later with `caw domain`.'))
    }
  }

  if (['full', 'frontend-api', 'api-only'].includes(nodeType)) {
    if (domain && process.env.CAW_DOMAIN) {
      section('Domain & Access')
      console.log(dim(`  Using domain ${domain} (from install.sh).`))
    }
    // --env preload: reuse admin password rather than re-prompting. Re-typing
    // a password the operator already chose is friction; silently rotating
    // it (which is what re-prompting does) invalidates existing admin
    // sessions. The .env value is a hash, not the plaintext, so this is
    // just file-to-env passthrough.
    if (process.env.CAW_ADMIN_PASSWORD) {
      adminPassword = process.env.CAW_ADMIN_PASSWORD
      console.log(dim('  Using admin password from --env preload.'))
    } else {
      const { adminPw } = await inquirer.prompt([
        {
          type: 'password',
          name: 'adminPw',
          message: 'Admin password (for the admin dashboard):',
          mask: '*',
          validate: (input) => input.length >= 8 ? true : 'Password must be at least 8 characters',
        },
      ])
      adminPassword = adminPw
    }
  }

  // Client ID. Each clientId on-chain scopes a separate sub-network: only
  // posts attributed to that client are visible to its users, and the client
  // owner controls the fees (mint, auth, deposit, withdraw) charged on-chain.
  // Most operators want to join the public network (clientId 1). Anyone with
  // ETH on L1 can create a new client via CawClientManager.createClient —
  // we offer that as a sub-flow when the validator key has the funds.
  let clientId = 1
  let storageChain = null // { key, label, eid } once known

  if (['full', 'frontend-api'].includes(nodeType)) {
    section('Client ID')
    // --env preload: skip the entire public/existing/create picker when we
    // have a clientId already. Operators almost never want to switch the
    // node's clientId mid-install — that's a fresh-install operation.
    if (process.env.CAW_CLIENT_ID && Number(process.env.CAW_CLIENT_ID) > 0) {
      clientId = Number(process.env.CAW_CLIENT_ID)
      console.log(dim(`  Using clientId ${clientId} from --env preload.`))
      // Look up the storage chain on-chain so the next step (L2 RPC)
      // can name it. Same lookup the regular path does later.
      if (ctx.l1RpcUrl) {
        storageChain = await lookupClientStorageChain(clientId, ctx.l1RpcUrl, ctx.network)
        if (storageChain) {
          console.log(dim(`  Client #${clientId} stores on ${storageChain.label}.`))
        }
      }
    } else {
    tipBlock([
      'Each CAW frontend is registered on-chain under a clientId.',
      '',
      `${brand('What does it do?')}`,
      '  • Scopes a sub-network: users on your frontend see posts attributed',
      '    to your clientId. Different clientIds form independent networks.',
      '  • The client owner sets the fees (mint / auth / deposit / withdraw)',
      '    charged on-chain for actions submitted under that client.',
      '  • The owner picks the storage chain and replication chains.',
    ])

    const choices = [
      { value: 'public', name: `${brand('Use clientId 1')} ${dim('(public CAW network — recommended)')}` },
      { value: 'existing', name: 'I already have a clientId' },
    ]
    if (ctx.l1RpcUrl && ctx.validatorPrivateKey) {
      choices.push({
        value: 'create',
        name: `${brand('Create a new client with my validator address')} ${dim('(needs ETH on L1)')}`,
      })
    }

    const { clientChoice } = await inquirer.prompt([
      { type: 'list', name: 'clientChoice', message: 'Client setup:', choices, default: 'public' },
    ])

    if (clientChoice === 'public') {
      clientId = 1
    } else if (clientChoice === 'existing') {
      const { clientIdInput } = await inquirer.prompt([
        {
          type: 'number',
          name: 'clientIdInput',
          message: 'Client ID:',
          validate: (input) => input > 0 ? true : 'Must be a positive number',
        },
      ])
      clientId = clientIdInput
    } else {
      const created = await createClientFlow({
        l1RpcUrl: ctx.l1RpcUrl,
        validatorPrivateKey: ctx.validatorPrivateKey,
        network: ctx.network,
      })
      if (created && typeof created === 'object') {
        clientId = created.clientId
        storageChain = {
          key: created.storageChainKey,
          label: created.storageChainLabel,
          eid: created.storageChainEid,
        }
      } else {
        // Operator backed out or tx failed — fall back to existing-id prompt
        // rather than crashing the whole install.
        console.log(dim('  Falling back to existing-clientId prompt.'))
        const { clientIdInput } = await inquirer.prompt([
          {
            type: 'number',
            name: 'clientIdInput',
            message: 'Client ID:',
            default: 1,
            validate: (input) => input > 0 ? true : 'Must be a positive number',
          },
        ])
        clientId = clientIdInput
      }
    }

    // For the public + existing-clientId branches we don't yet know the
    // storage chain. Look it up on-chain so the next step (L2 RPC prompt)
    // can name the actual chain. Lookup is best-effort — if it fails we'll
    // fall back to a generic L2 label.
    if (!storageChain && ctx.l1RpcUrl) {
      storageChain = await lookupClientStorageChain(clientId, ctx.l1RpcUrl, ctx.network)
      if (storageChain) {
        console.log(dim(`  Client #${clientId} stores on ${storageChain.label}.`))
      } else {
        console.log(dim(`  Couldn't read client #${clientId}'s storage chain on-chain — L2 prompt will use a generic label.`))
      }
    }
    } // close --env preload else
  }

  // WalletConnect / Reown — frontend-bearing nodes only. Asked here so the
  // operator doesn't bounce between phases.
  const walletConnectProjectId = await collectWalletConnectProjectId(nodeType)

  // Giphy API key — backend-only env var; powers the in-composer GIF picker
  // via /api/giphy proxy. Asked for any node that runs the API.
  const giphyApiKey = await collectGiphyApiKey(nodeType)

  // On-chain instance announcement. Only meaningful when this node serves
  // an API (other nodes need a URL to talk to) AND we have a domain to
  // announce. The InstanceRegistryService handles the actual registration
  // tx on first boot — we just decide whether to give it a URL.
  // Collected BEFORE the X OAuth step so that step can show the operator
  // the exact callback URL (derived from this URL) to paste into the X
  // app's settings.
  const instanceApiUrl = await collectInstanceRegistration(nodeType, domain)

  // X (Twitter) OAuth credentials — backend-only env vars; power the
  // /api/verify/x flow that links a CAW profile to an X account and pulls a
  // bucketed follower count for the verified-account badge. Asked for any
  // node that runs the API. Callback URL is derived from instanceApiUrl at
  // request time so the operator can't drift the X-app config out of sync
  // with where the API actually lives.
  const xOAuth = await collectXOAuth(nodeType, instanceApiUrl, domain)

  // Sentry DSN (optional) — error reporting for both server + browser.
  const sentryDsn = await collectSentryDsn(nodeType)

  // SigNoz / OTLP collector endpoint (optional) — performance tracing for
  // the backend process. Same opt-in pattern as Sentry: leaving it blank
  // is a no-op at runtime. Auto-installs SigNoz on this box if the
  // operator picks that option; otherwise asks for an existing URL.
  const { endpoint: signozEndpoint, serviceName: otelServiceName } =
    await collectSignozEndpoint(nodeType, { domain, clientId })

  result.domain = domain
  result.adminPassword = adminPassword
  result.clientId = clientId
  result.storageChain = storageChain
  result.walletConnectProjectId = walletConnectProjectId
  result.giphyApiKey = giphyApiKey
  result.xOAuthClientId = xOAuth.clientId
  result.xOAuthClientSecret = xOAuth.clientSecret
  result.instanceApiUrl = instanceApiUrl
  result.sentryDsn = sentryDsn
  result.signozEndpoint = signozEndpoint
  result.otelServiceName = otelServiceName
  return result
}

/**
 * Phase 2 of infra collection: DB + Redis + Elasticsearch + API port +
 * docker mode. Runs AFTER the L2 RPC step. None of these depend on chain
 * state, so we can collect them once we're past the on-chain bits.
 */
export async function collectInfraLate(nodeType) {
  if (nodeType === 'frontend-only') {
    // Frontend-only's infra was fully collected in collectInfraEarly via
    // collectFrontendOnlyConfig. Nothing else to do.
    return {}
  }

  // Infra mode is set by install.sh before we run; we just honor it here.
  // Map the shell's three modes into the legacy `useDocker` value the rest
  // of the CLI passes around.
  //   native   → 'local'   — apt-installed services on 127.0.0.1, defaults are right
  //   docker   → 'docker'  — write docker-compose, prompt for a db password
  //   existing → 'existing' — collect URLs (or honor pre-set env vars)
  const infraMode = process.env.CAW_INFRA_MODE || 'native'
  const useDocker = infraMode === 'native' ? 'local' : infraMode

  // Each install gets its own Postgres database so multiple CAW nodes can
  // share one Postgres server. Derive the DB name from the domain (postgres
  // identifier rules: lowercase, alphanumeric + underscore). Operators with
  // their own existing DB override via CAW_DB_URL.
  const domainSlug = (process.env.CAW_DOMAIN || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50) // postgres identifiers are bounded; trim long subdomains
  const defaultDbName = `caw_${domainSlug || 'default'}`

  let dbUrl = process.env.CAW_DB_URL || `postgresql://postgres:postgres@127.0.0.1:5432/${defaultDbName}`
  let redisUrl = process.env.CAW_REDIS_URL || 'redis://127.0.0.1:6379'
  let elasticsearchNode = process.env.CAW_ES_URL || 'http://127.0.0.1:9200'

  if (infraMode === 'docker' && !process.env.CAW_DB_URL) {
    section('Database password')
    const { dbPassword } = await inquirer.prompt([
      {
        type: 'password',
        name: 'dbPassword',
        message: `PostgreSQL password ${dim('(for the Docker container)')}:`,
        default: 'caw_' + Math.random().toString(36).slice(2, 10),
        mask: '*',
      },
    ])
    dbUrl = `postgresql://postgres:${dbPassword}@127.0.0.1:5432/${defaultDbName}`
  } else if (infraMode === 'existing') {
    section('Existing services')
    tipBlock([
      'You picked "connect to existing services". Provide URLs for each.',
      'Set CAW_DB_URL / CAW_REDIS_URL / CAW_ES_URL in the env to skip these',
      'prompts in future runs.',
    ])
    const prompts = []
    if (!process.env.CAW_DB_URL) prompts.push({
      type: 'input', name: 'dbUrl',
      message: 'PostgreSQL connection URL:',
      default: dbUrl,
      validate: (input) => input.startsWith('postgresql://') ? true : 'Must be a PostgreSQL URL',
    })
    if (!process.env.CAW_REDIS_URL) prompts.push({
      type: 'input', name: 'redisUrl',
      message: 'Redis connection URL:',
      default: redisUrl,
      validate: (input) => input.startsWith('redis://') ? true : 'Must be a Redis URL',
    })
    if (!process.env.CAW_ES_URL) prompts.push({
      type: 'input', name: 'elasticsearchNode',
      message: `Elasticsearch URL ${dim('(optional — search degrades gracefully if unreachable)')}:`,
      default: elasticsearchNode,
      validate: (input) => /^https?:\/\//.test(input) ? true : 'Must start with http:// or https://',
    })
    if (prompts.length) {
      const answers = await inquirer.prompt(prompts)
      if (answers.dbUrl) dbUrl = answers.dbUrl
      if (answers.redisUrl) redisUrl = answers.redisUrl
      if (answers.elasticsearchNode) elasticsearchNode = answers.elasticsearchNode
    }
  }

  // API port — hardcoded with an env override (CAW_API_PORT) for the rare
  // case where 4000 is taken. We don't ask, because end-users never care
  // and the answer is meaningless to anyone debugging.
  const apiPort = Number(process.env.CAW_API_PORT) || 4000

  return {
    useDocker,
    dbUrl,
    redisUrl,
    elasticsearchNode,
    apiPort,
  }
}

/**
 * Backwards-compat wrapper: collects everything in one shot in the OLD
 * order (domain → DB → client → …). Kept so external callers / tests that
 * import collectInfraConfig still work. Production CLI now uses
 * collectInfraEarly + L2 RPC step + collectInfraLate to thread the chosen
 * storage chain through to the L2 RPC prompt.
 */
export async function collectInfraConfig(nodeType, ctx = {}) {
  const early = await collectInfraEarly(nodeType, ctx)
  const late = await collectInfraLate(nodeType)
  return { ...early, ...late }
}

async function collectFrontendOnlyConfig(ctx = {}) {
  section('Frontend Configuration')

  tipBlock([
    'A frontend-only node serves the React app as a static site.',
    'All data comes from an external API hosted by another client.',
  ])

  // Try to pull the client + instance list from the on-chain registry
  // first. Falls through to the free-text prompt below if the picker
  // returns null (RPC unreachable, no clients yet, no instances for the
  // chosen client, or operator picks "Other").
  let apiUrl = await pickClientAndApi({ network: ctx.network })

  if (!apiUrl) {
    const answer = await inquirer.prompt([
      {
        type: 'input',
        name: 'apiUrl',
        message: 'External API URL (e.g., https://api.caw.example.com):',
        validate: (input) => {
          if (!input.startsWith('http')) return 'Must be an HTTP(S) URL'
          return true
        }
      }
    ])
    apiUrl = answer.apiUrl
  }

  const { domain } = await inquirer.prompt([
    {
      type: 'input',
      name: 'domain',
      message: `Domain name ${dim('(optional, press Enter to skip)')}:`,
      default: ''
    }
  ])

  const walletConnectProjectId = await collectWalletConnectProjectId('frontend-only')
  const sentryDsn = await collectSentryDsn('frontend-only')

  return { apiUrl, domain, useDocker: false, walletConnectProjectId, sentryDsn }
}

/**
 * Ask for the operator's WalletConnect / Reown project ID. Only applies to
 * node types that bundle the frontend (full / frontend-api / frontend-only).
 *
 * Why we don't bake one in: project IDs are tied to *one* dashboard at
 * cloud.reown.com. Quotas, analytics, and origin allowlists all live there.
 * Sharing the project author's ID across every install would mean every
 * operator's traffic counts against one dashboard's quota and any rotation
 * breaks every install at once.
 *
 * Honors CAW_WALLETCONNECT_PROJECT_ID env override for non-interactive
 * runs (CI, install.sh pre-set, etc.).
 */
async function collectWalletConnectProjectId(nodeType) {
  if (!['full', 'frontend-api', 'frontend-only'].includes(nodeType)) return ''

  const fromEnv = process.env.CAW_WALLETCONNECT_PROJECT_ID
  if (fromEnv) return fromEnv

  section('WalletConnect (Reown) project ID')
  tipBlock([
    `${brand('What is this?')}`,
    'When users on your CAW frontend click "Connect Wallet", the picker',
    'modal is powered by WalletConnect (now Reown). Mobile wallets like',
    'MetaMask Mobile, Rainbow, Trust, etc. talk to the site through Reown\'s',
    'relay servers. Without a project ID, the modal falls back to a',
    'placeholder and WC-based wallets simply can\'t connect.',
    '',
    `${brand('Why each operator needs their own:')}`,
    'Project IDs are tied to one dashboard at cloud.reown.com — the dashboard',
    'controls quota (free tier is generous), origin allowlists (which domains',
    'can use this ID), and per-install analytics. Sharing one ID across many',
    'installs would mean every operator\'s traffic eats one quota and every',
    'rotation breaks every install.',
    '',
    `${brand('How to get one (about 60 seconds):')}`,
    `  ${brand('1.')} Open ${brand('https://cloud.reown.com')} in your browser`,
    `  ${brand('2.')} Sign in with email, Google, GitHub, or a wallet`,
    `  ${brand('3.')} Click "Create Project". Name it whatever you like — it\'s only`,
    '     visible in your dashboard.',
    `  ${brand('4.')} Pick "AppKit" as the SDK type (the default).`,
    `  ${brand('5.')} Copy the ${brand('Project ID')} from the project page (32 hex chars).`,
    `  ${brand('6.')} Paste it below.`,
    '',
    `${brand('Optional — domain allowlist:')}`,
    'In the project settings, you can restrict which domains use this ID.',
    'For a public install, add your domain (e.g. "yourdomain.com"). For dev,',
    'add "localhost" too. Leaving it open is fine to start; lock it down once',
    'you\'re live.',
    '',
    'You can leave the prompt blank to skip and add VITE_PROJECT_ID to',
    'client/src/services/FrontEnd/.env later — the rest of the install will',
    'still work, only WalletConnect-based wallets will be unavailable.',
  ])

  const { projectId } = await inquirer.prompt([
    {
      type: 'input',
      name: 'projectId',
      message: 'WalletConnect project ID (32-char hex):',
      default: '',
      validate: (input) => {
        const v = input.trim()
        if (!v) return true // optional
        if (!/^[a-f0-9]{32}$/i.test(v)) {
          return 'Project ID should be 32 hex characters (or leave blank to skip)'
        }
        return true
      },
    },
  ])

  return projectId.trim()
}

/**
 * Ask for a Giphy API key. Powers the in-composer GIF picker via the
 * backend's /api/giphy proxy (server-side only — the key never ships to
 * the browser). Only relevant for node types that run the API.
 *
 * Honors CAW_GIPHY_API_KEY env override for non-interactive runs. Blank
 * skips — /api/giphy returns a 500 when GIPHY_API_KEY is unset, so the
 * GIF picker shows an error to the user but the rest of the app still
 * works.
 */
async function collectGiphyApiKey(nodeType) {
  if (!['full', 'frontend-api', 'api-only'].includes(nodeType)) return ''

  const fromEnv = process.env.CAW_GIPHY_API_KEY
  if (fromEnv) return fromEnv

  section('Giphy API key (optional)')
  tipBlock([
    `${brand('What is this?')}`,
    'The post composer has a GIF picker powered by Giphy. Your API server',
    'proxies requests to Giphy with this key — the key never leaves your',
    'server (no VITE_ prefix; it stays in the backend .env).',
    '',
    `${brand('How to get one (about 60 seconds):')}`,
    `  ${brand('1.')} Open ${brand('https://developers.giphy.com')} in your browser`,
    `  ${brand('2.')} Sign in (Google / Facebook / email)`,
    `  ${brand('3.')} Click "Create an App" → "API" (not SDK)`,
    `  ${brand('4.')} Name it whatever you like — only visible in your dashboard`,
    `  ${brand('5.')} Copy the ${brand('API key')} (32 hex chars) and paste below`,
    '',
    'Leave blank to skip — the GIF picker just won\'t work until you add',
    'GIPHY_API_KEY to client/.env later. The rest of the app is unaffected.',
  ])

  const { apiKey } = await inquirer.prompt([
    {
      type: 'input',
      name: 'apiKey',
      message: 'Giphy API key:',
      default: '',
      validate: (input) => {
        const v = input.trim()
        if (!v) return true // optional
        if (!/^[a-zA-Z0-9]{20,}$/.test(v)) {
          return 'Looks too short / has unexpected characters (or leave blank to skip)'
        }
        return true
      },
    },
  ])

  return apiKey.trim()
}

/**
 * Ask for X (Twitter) OAuth 2.0 credentials. Powers the /api/verify/x flow
 * that links a CAW profile to an X handle (and pulls a bucketed follower
 * count once at link time) so accounts can earn a verified-account badge.
 * Server-side only — neither the client ID nor secret ships to the browser.
 *
 * The OAuth callback URL is NOT prompted — it's derived at request time as
 * `${INSTANCE_API_URL}/api/verify/x/callback`. We only show the operator
 * what URL to paste into the X dev portal so the X-app config stays in
 * lockstep with the actual API origin.
 *
 * Honors CAW_X_OAUTH_CLIENT_ID / CAW_X_OAUTH_CLIENT_SECRET env overrides
 * for non-interactive runs. Blank skips — /api/verify/x/start-popup returns
 * 500 when env is unset, so the Connect X button shows an error to the
 * user but the rest of the app is unaffected.
 *
 * Note: X has TWO credential pairs per app — "Consumer Keys" (OAuth 1.0a)
 * and "OAuth 2.0 Client ID and Client Secret". We need the OAuth 2.0 pair,
 * not the consumer keys. The prompt copy is explicit about this because
 * it's a common footgun.
 */
async function collectXOAuth(nodeType, instanceApiUrl, domain) {
  if (!['full', 'frontend-api', 'api-only'].includes(nodeType)) {
    return { clientId: '', clientSecret: '' }
  }

  const fromEnvId     = process.env.CAW_X_OAUTH_CLIENT_ID
  const fromEnvSecret = process.env.CAW_X_OAUTH_CLIENT_SECRET
  if (fromEnvId && fromEnvSecret) {
    return { clientId: fromEnvId, clientSecret: fromEnvSecret }
  }

  // Build the derived callback URL the operator must paste into the X app.
  // Prefer the just-collected instanceApiUrl; fall back to https://<domain>
  // if instance announcement was skipped. If even domain is empty we can't
  // give them a callback to paste, so we skip the whole step.
  const apiOrigin = (instanceApiUrl || (domain ? `https://${domain}` : '')).replace(/\/+$/, '')
  if (!apiOrigin) {
    console.log(dim('  Skipping X OAuth — no INSTANCE_API_URL or domain to derive callback from.'))
    return { clientId: '', clientSecret: '' }
  }
  const callbackUrl = `${apiOrigin}/api/verify/x/callback`
  const websiteUrl  = apiOrigin

  section('X (Twitter) OAuth credentials (optional)')
  tipBlock([
    `${brand('What is this?')}`,
    'CAW can link a profile to an X account via OAuth and pull a bucketed',
    'follower count, so brands and famous accounts get a verified-account',
    'badge. The credentials stay server-side (no VITE_ prefix; never shipped',
    'to the browser).',
    '',
    `${brand('How to get the credentials (about 5 minutes):')}`,
    `  ${brand('1.')} Open ${brand('https://developer.x.com/en/portal/dashboard')}`,
    `  ${brand('2.')} Create a project + app (or pick an existing one)`,
    `  ${brand('3.')} App settings → ${brand('User authentication settings')} → Set up`,
    `  ${brand('4.')} App permissions: ${brand('Read')}`,
    `  ${brand('5.')} Type of App: ${brand('Web App')} (Confidential client)`,
    `  ${brand('6.')} Callback URI: ${brand(callbackUrl)}`,
    `  ${brand('7.')} Website URL: ${brand(websiteUrl)}`,
    `  ${brand('8.')} Save. Then ${brand('Keys and tokens')} tab → "OAuth 2.0 Client ID and Client Secret" → Generate`,
    '',
    `${brand('IMPORTANT')}: there are two credential pairs on the page —`,
    `${brand('"Consumer Keys"')} (OAuth 1.0a) and ${brand('"OAuth 2.0 Client ID and Client Secret"')}.`,
    `We need the ${brand('OAuth 2.0')} pair, not the Consumer Keys.`,
    '',
    `${brand('Note')}: the callback URL is derived from your API origin`,
    '(INSTANCE_API_URL or domain). If you change either later, update the',
    'X app\'s Callback URI to match — the new callback is logged on every',
    '/api/verify/x/start-popup call so you can grep for it.',
    '',
    'Leave blank to skip — the Connect X button will show an error until you',
    'add X_OAUTH_CLIENT_ID / X_OAUTH_CLIENT_SECRET to client/.env later.',
    'The rest of the app is unaffected.',
  ])

  const { clientId } = await inquirer.prompt([
    {
      type: 'input',
      name: 'clientId',
      message: 'X OAuth 2.0 Client ID:',
      default: '',
      validate: (input) => {
        const v = input.trim()
        if (!v) return true
        // X OAuth 2.0 client IDs look like base64url, 30+ chars. Don't
        // pin a hard length — they may evolve. Just sanity-check the
        // charset so a fat-fingered paste fails fast.
        if (!/^[A-Za-z0-9_-]{20,}$/.test(v)) {
          return 'Looks too short / has unexpected characters (or leave blank to skip)'
        }
        return true
      },
    },
  ])

  const idTrim = clientId.trim()
  if (!idTrim) {
    console.log(dim('  Skipping — Connect X will show an error until you fill these in later.'))
    return { clientId: '', clientSecret: '' }
  }

  const { clientSecret } = await inquirer.prompt([
    {
      type: 'password',
      name: 'clientSecret',
      message: 'X OAuth 2.0 Client Secret:',
      mask: '*',
      validate: (input) => {
        const v = input.trim()
        if (!v) return 'Client secret is required when client ID is set'
        if (!/^[A-Za-z0-9_-]{30,}$/.test(v)) {
          return 'Looks too short / has unexpected characters'
        }
        return true
      },
    },
  ])

  return {
    clientId:     idTrim,
    clientSecret: clientSecret.trim(),
  }
}

/**
 * Ask whether to announce this node's API URL on-chain so other CAW
 * instances can find it (DM relay, mention propagation across instances,
 * etc.). The InstanceRegistryService handles the actual registerInstance
 * tx on first boot — this prompt just decides whether to give it a URL.
 *
 * Only relevant for API-serving node types with a domain. Honors
 * CAW_INSTANCE_API_URL env override (e.g. to announce a different URL
 * than the install's own domain).
 */
async function collectInstanceRegistration(nodeType, domain) {
  if (!['full', 'frontend-api', 'api-only'].includes(nodeType)) return ''

  const fromEnv = process.env.CAW_INSTANCE_API_URL
  if (fromEnv) return fromEnv

  if (!domain) {
    // Without a public domain there's nothing useful to announce; other
    // nodes can't route to localhost. Skip silently.
    return ''
  }

  section('Announce this node on-chain (optional)')
  tipBlock([
    `${brand('What is this?')}`,
    'Each CAW instance can register its API URL on-chain via',
    `${brand('CawClientManager.registerInstance')}. Other instances read the registry`,
    'to route DMs and mentions to your users when they see activity from',
    'someone authenticated against your client.',
    '',
    `${brand('What does it cost?')}`,
    '  • One L1 tx (one-time, only if you change your URL or validator).',
    '    Updates use the same fn — no new registration needed.',
    '  • Your validator address ↔ domain pairing becomes publicly visible',
    '    on-chain. Most operators are fine with this; if you\'d rather not,',
    '    skip.',
    '',
    `${brand('What if I skip?')}`,
    '  Your node still works. Users on YOUR domain see everything. But other',
    '  instances can\'t route inbound DMs / mentions to your users; they show',
    '  up at your node only if they hit your URL directly.',
    '',
    `Will announce: ${brand('https://' + domain)}`,
  ])

  const { announce } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'announce',
      message: 'Announce this node on-chain?',
      default: true,
    },
  ])

  return announce ? `https://${domain}` : ''
}

/**
 * Ask for a Sentry DSN. When set, the backend forwards uncaught
 * exceptions / rejections to Sentry; the frontend bundles VITE_SENTRY_DSN
 * for browser-side error reporting via @sentry/react. Both are gated by
 * env var presence so the install works fine without it.
 *
 * Honors CAW_SENTRY_DSN env override. The same DSN is used for both
 * server and browser — Sentry differentiates by event source. Operators
 * with a separate browser DSN can edit the .env files manually.
 *
 * Only relevant for node types that run code (full / api-only /
 * frontend-api / validator / frontend-only). Validator-only and
 * api-only nodes still benefit from server-side error reporting.
 */
async function collectSentryDsn(nodeType) {
  if (nodeType === 'frontend-only' && !process.env.CAW_SENTRY_DSN) {
    // Frontend-only nodes don't have a backend to report to — only the
    // browser side benefits, but we still ask if the operator wants it.
  }

  const fromEnv = process.env.CAW_SENTRY_DSN
  if (fromEnv) return fromEnv

  section('Sentry error tracking (optional)')
  tipBlock([
    `${brand('What is this?')}`,
    'Sentry collects uncaught exceptions and errors from your running node',
    'so you can see what\'s breaking in production. Both the API server and',
    'the frontend report to the same DSN.',
    '',
    `${brand('How to get a DSN (about 60 seconds):')}`,
    `  ${brand('1.')} Open ${brand('https://sentry.io')} and sign in (or sign up — free tier`,
    '     covers small operators).',
    `  ${brand('2.')} Create a project → pick "Browser JavaScript" or "Node.js" (either`,
    '     works; Sentry routes events by source).',
    `  ${brand('3.')} Copy the DSN URL (looks like https://abc...@oxxxx.ingest.sentry.io/N).`,
    `  ${brand('4.')} Paste below.`,
    '',
    'Leave blank to skip — error handling falls back to plain console logs',
    'and pm2 log files. You can add SENTRY_DSN / VITE_SENTRY_DSN to the env',
    'files later without re-running install.',
  ])

  const { dsn } = await inquirer.prompt([
    {
      type: 'input',
      name: 'dsn',
      message: 'Sentry DSN URL:',
      default: '',
      validate: (input) => {
        const v = input.trim()
        if (!v) return true // optional
        if (!/^https:\/\/[a-zA-Z0-9]+@[a-zA-Z0-9.-]+\.ingest(\.[a-z]+)?\.sentry\.io\/\d+$/.test(v)) {
          return 'Doesn\'t look like a Sentry DSN URL (expected https://KEY@oXXXX.ingest.sentry.io/N)'
        }
        return true
      },
    },
  ])

  return dsn.trim()
}

// Default location for the SigNoz install when the operator picks "install
// on this box". Box-level path (NOT per-installDir) so multiple CAW instances
// on one host share a single collector — the second instance's CLI run will
// detect the existing SigNoz via the localhost probe and just point at it.
function defaultSignozInstallPath() {
  const home = os.homedir()
  if (home && home !== '/') return path.join(home, '.caw-signoz')
  return '/opt/caw-signoz'
}

// Probe a TCP port with a tight timeout. Used to detect whether SigNoz's
// OTLP collector is already running on this box without depending on the
// full HTTP stack (the collector replies to anything but doesn't always
// return 200 to a HEAD; a TCP-connect probe is the most reliable signal).
async function probeTcp(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try { sock.destroy() } catch {}
      resolve(ok)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    sock.connect(port, host)
  })
}

// Detect docker + compose. SigNoz is docker-only, so the auto-install option
// is hidden when neither is available. We accept both `docker compose` (v2
// plugin, current) and `docker-compose` (v1 standalone, legacy) and report
// which one to use later.
function detectDocker() {
  const has = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0
  if (!has('docker')) return null
  // `docker compose version` exits 0 when the plugin is available.
  const v2 = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0
  if (v2) return { cmd: 'docker', composeArgs: ['compose'] }
  if (has('docker-compose')) return { cmd: 'docker-compose', composeArgs: [] }
  return null
}

// Returns null when this isn't an apt-based distro. When it is, returns
// { sudoPrefix } — empty string when running as root, "sudo " otherwise.
// Only sudo is supported (no doas / pkexec) because that's what the rest of
// the CLI assumes; matches install.sh.
function detectApt() {
  if (process.platform !== 'linux') return null
  if (spawnSync('command', ['-v', 'apt-get'], { stdio: 'ignore', shell: true }).status !== 0) return null
  if (process.getuid && process.getuid() === 0) return { sudoPrefix: '' }
  if (spawnSync('command', ['-v', 'sudo'], { stdio: 'ignore', shell: true }).status !== 0) return null
  return { sudoPrefix: 'sudo ' }
}

// Install Docker engine + compose plugin via the official Docker apt repo.
// Mirrors the recipe in install.sh — same keyring path, same package set,
// same arch detection — so a box bootstrapped one way matches the other.
// Throws on any step's failure; caller catches and falls back gracefully.
function installDockerApt(apt) {
  const { sudoPrefix } = apt
  console.log(dim('  Installing Docker (engine + compose plugin) via apt — this is a one-time, box-level change.'))
  const steps = [
    `${sudoPrefix}install -m 0755 -d /etc/apt/keyrings`,
    `curl -fsSL https://download.docker.com/linux/ubuntu/gpg | ${sudoPrefix}gpg --dearmor -o /etc/apt/keyrings/docker.gpg`,
    `${sudoPrefix}chmod a+r /etc/apt/keyrings/docker.gpg`,
    `echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | ${sudoPrefix}tee /etc/apt/sources.list.d/docker.list >/dev/null`,
    `${sudoPrefix}apt-get update -qq`,
    `${sudoPrefix}apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`,
  ]
  for (const cmd of steps) {
    try {
      execSync(cmd, { stdio: 'pipe', shell: '/bin/bash' })
    } catch (e) {
      throw new Error(`apt step failed (${cmd.slice(0, 80)}…): ${e.message?.slice(0, 200) || e}`)
    }
  }
  // Add the invoking user to the docker group so they don't need sudo for
  // every docker command going forward. SigNoz auto-install runs as the
  // same user (we don't sudo the docker compose), so without group
  // membership the very next step would EACCES on the docker socket.
  // SUDO_USER is set by sudo; falls back to USER for the run-as-root case.
  const targetUser = process.env.SUDO_USER || process.env.USER
  if (targetUser && targetUser !== 'root') {
    try {
      execSync(`${sudoPrefix}usermod -aG docker ${targetUser}`, { stdio: 'pipe', shell: '/bin/bash' })
      console.log(dim(`  Added ${targetUser} to the docker group (takes effect on next login).`))
    } catch (e) {
      console.log(warn(`  Couldn't add ${targetUser} to the docker group: ${e.message?.slice(0, 200) || e}`))
      console.log(dim('  You may need to run docker commands with sudo until the group membership refreshes.'))
    }
  }
  console.log(success('  Docker installed.'))
}

// Auto-derive a service name from the operator's identity so multiple CAW
// instances on one box (or on one shared SigNoz) appear as distinct services
// in the UI instead of a confusing merged blob. Operator can override via
// CAW_OTEL_SERVICE_NAME — same skip-the-prompt pattern as everything else.
function deriveServiceName(config) {
  const fromEnv = process.env.CAW_OTEL_SERVICE_NAME
  if (fromEnv) return fromEnv
  if (config.domain) return `caw-${String(config.domain).replace(/[^a-zA-Z0-9-]/g, '-')}`
  if (config.clientId) return `caw-client-${config.clientId}`
  return 'caw-backend'
}

// Clone (or update) SigNoz into installPath and run docker compose up. Polls
// the OTLP port until ready or times out. Throws on hard failure so the
// caller can fall back to "skip" or "different box". Idempotent — re-running
// on an already-installed checkout is a no-op.
async function installSignozOnThisBox(installPath, docker) {
  fs.mkdirSync(installPath, { recursive: true })
  const repoDir = path.join(installPath, 'signoz')

  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    console.log(dim(`  Cloning SigNoz into ${repoDir} (~50MB, one-time)…`))
    try {
      execSync(`git clone --depth 1 -b main https://github.com/SigNoz/signoz.git "${repoDir}"`, {
        stdio: 'pipe',
      })
    } catch (e) {
      throw new Error(`git clone failed: ${e.message?.slice(0, 200) || e}`)
    }
  } else {
    console.log(dim(`  SigNoz checkout already at ${repoDir} — reusing.`))
  }

  // SigNoz reorganized their repo: the compose file used to live under
  // deploy/docker/clickhouse-setup/, then moved to deploy/docker/. Try
  // the current layout first, fall back to the legacy path. If neither
  // exists they've moved it again — fail loud so the operator gets a
  // useful error rather than a silent docker-compose-up no-op.
  const candidatePaths = [
    path.join(repoDir, 'deploy', 'docker', 'docker-compose.yaml'),
    path.join(repoDir, 'deploy', 'docker', 'clickhouse-setup', 'docker-compose.yaml'),
  ]
  const composeFile = candidatePaths.find(p => fs.existsSync(p))
  if (!composeFile) {
    throw new Error(`No SigNoz docker-compose file found. Looked at:\n  ${candidatePaths.join('\n  ')}\nThe SigNoz repo layout may have changed again — please file an issue or pick "different box" and run SigNoz manually.`)
  }

  console.log(dim('  Starting SigNoz containers (ClickHouse migrations on first boot take 1–2 min)…'))
  try {
    execSync(`${docker.cmd} ${docker.composeArgs.join(' ')} -f "${composeFile}" up -d`, {
      stdio: 'pipe',
    })
  } catch (e) {
    throw new Error(`docker compose up failed: ${e.message?.slice(0, 300) || e}`)
  }

  // Poll OTLP port. ClickHouse's first-boot migrations take time; print
  // periodic progress so it doesn't look hung.
  const startedAt = Date.now()
  const TIMEOUT_MS = 120_000
  let lastProgress = 0
  while (Date.now() - startedAt < TIMEOUT_MS) {
    if (await probeTcp('127.0.0.1', 4318, 500)) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000)
      console.log(success(`  SigNoz collector ready on :4318 (${elapsed}s)`))
      // SigNoz consolidated their UI onto port 8080 (same image as the
      // backend). Older docs reference :3301 from the legacy split-image
      // layout — current installs land on 8080.
      console.log(dim(`  UI: ${brand('http://localhost:8080')}  (create your account on first visit)`))
      return
    }
    if (Date.now() - lastProgress > 15_000) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000)
      console.log(dim(`  …still waiting for SigNoz to boot (${elapsed}s elapsed)`))
      lastProgress = Date.now()
    }
    await new Promise(r => setTimeout(r, 3000))
  }
  throw new Error(`SigNoz didn't become reachable on localhost:4318 within 120s. Check ${docker.cmd} ${docker.composeArgs.join(' ')} -f "${composeFile}" logs and re-run install once it's up, or pick "different box" and paste the URL manually.`)
}

/**
 * Ask where the operator wants to send OTel traces, and (if they pick the
 * auto-install option) actually install SigNoz on this box. Returns
 * { endpoint, serviceName } — both written to .env by generate.js.
 *
 * Behaviour matrix:
 *   • CAW_SIGNOZ_ENDPOINT preset  → use it, skip prompt entirely
 *   • SigNoz already on :4318     → offer "use existing" as an option
 *   • Docker available            → offer "install on this box" as an option
 *   • Always offer                → "different box" (paste URL) and "skip"
 *
 * The endpoint is the standard OTLP/HTTP base URL — works against any
 * OTLP-compatible collector (Tempo, Honeycomb, etc.), not just SigNoz.
 *
 * Skipped for frontend-only nodes (no backend to instrument).
 */
async function collectSignozEndpoint(nodeType, config) {
  if (nodeType === 'frontend-only') return { endpoint: '', serviceName: '' }

  const fromEnv = process.env.CAW_SIGNOZ_ENDPOINT
  if (fromEnv) {
    return { endpoint: fromEnv, serviceName: deriveServiceName(config) }
  }

  section('Performance tracing with SigNoz (optional)')
  tipBlock([
    `${brand('What is this?')}`,
    'SigNoz is a self-hosted observability platform. When pointed at it, this',
    'node emits traces for every HTTP request, Prisma query, Redis call, and',
    'RPC call — so you can see which endpoints / queries / external calls are',
    'slow, and where time is spent inside a request.',
    '',
    'One SigNoz collector can serve many CAW nodes — multiple instances on one',
    'box should share a single install. They show up as separate services in',
    'the UI via OTEL_SERVICE_NAME (auto-derived from your domain / clientId).',
  ])

  let docker = detectDocker()
  const alreadyRunning = await probeTcp('127.0.0.1', 4318, 500)
  // When SigNoz is already up, we don't need Docker locally — we're just
  // going to write the URL. Docker only matters for the auto-install path.
  const apt = !docker && !alreadyRunning ? detectApt() : null

  // "Install on this box" and "use existing on this box" collapse into one
  // option — they yield the same endpoint (http://localhost:4318) and the
  // user shouldn't have to know whether SigNoz happens to already be running
  // before they answer. The action behind the option diverges based on the
  // probe: install fresh when nothing's there, just point at it when it is.
  // When Docker is missing on an apt-based system, we also offer to install
  // Docker first — same recipe install.sh uses for the docker infra mode.
  const localOptionAvailable = alreadyRunning || !!docker || !!apt
  const choices = []
  if (localOptionAvailable) {
    let label
    if (alreadyRunning) {
      label = `Use SigNoz on this box (already running at ${brand('http://localhost:4318')})`
    } else if (docker) {
      label = `Use SigNoz on this box (Docker required, ~2GB RAM, ~30GB disk — auto-installs)`
    } else {
      label = `Use SigNoz on this box (auto-installs Docker via apt + SigNoz, ~2GB RAM, ~30GB disk)`
    }
    choices.push({ name: label, value: 'local' })
  }
  choices.push({ name: `Use SigNoz running on a different box (I'll paste the URL)`, value: 'remote' })
  choices.push({ name: `Skip — no performance tracing`, value: 'skip' })

  if (!localOptionAvailable) {
    console.log(dim('  Docker not detected and nothing on :4318. This box isn\'t apt-based either, so'))
    console.log(dim('  the CLI can\'t auto-install Docker for you. Install Docker manually'))
    console.log(dim('  (https://docs.docker.com/get-docker/) and re-run, or pick "different box".'))
  }

  const { mode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'mode',
      message: 'How do you want to handle performance tracing?',
      choices,
      default: localOptionAvailable ? 'local' : 'skip',
    },
  ])

  if (mode === 'skip') return { endpoint: '', serviceName: '' }

  if (mode === 'local') {
    if (alreadyRunning) {
      return {
        endpoint: 'http://localhost:4318',
        serviceName: deriveServiceName(config),
      }
    }
    // Install Docker first if we got here via the apt-no-docker path. Re-detect
    // afterwards so we have the right { cmd, composeArgs } shape for SigNoz.
    if (!docker && apt) {
      try {
        installDockerApt(apt)
      } catch (e) {
        console.log(warn(`  Docker install didn't complete: ${e.message}`))
        console.log(dim('  Falling back to "skip" — you can install Docker manually and re-run install later.'))
        return { endpoint: '', serviceName: '' }
      }
      docker = detectDocker()
      if (!docker) {
        console.log(warn('  Docker installed but the CLI can\'t see it — the apt install may need a fresh shell.'))
        console.log(dim('  Falling back to "skip" — re-run install in a new shell to continue.'))
        return { endpoint: '', serviceName: '' }
      }
    }
    const installPath = defaultSignozInstallPath()
    console.log(dim(`  Install location: ${installPath}`))
    console.log(warn('  Heads up: SigNoz wants ~4GB RAM and ~30GB disk. Continuing anyway — it will fail loudly if the box is too small.'))
    try {
      await installSignozOnThisBox(installPath, docker)
      return {
        endpoint: 'http://localhost:4318',
        serviceName: deriveServiceName(config),
      }
    } catch (e) {
      console.log(warn(`  SigNoz install didn't complete: ${e.message}`))
      console.log(dim('  Falling back to "skip" — you can add OTEL_EXPORTER_OTLP_ENDPOINT to .env later without re-running install.'))
      return { endpoint: '', serviceName: '' }
    }
  }

  // mode === 'remote'
  const { endpoint } = await inquirer.prompt([
    {
      type: 'input',
      name: 'endpoint',
      message: 'OTLP collector endpoint (e.g. http://signoz.internal:4318):',
      default: '',
      validate: (input) => {
        const v = input.trim()
        if (!v) return 'Required when picking "different box" — pick "skip" if you don\'t have one yet'
        if (!/^https?:\/\/.+/.test(v)) {
          return 'Expected an http(s) URL pointing at the OTLP collector base'
        }
        return true
      },
    },
  ])

  return {
    endpoint: endpoint.trim(),
    serviceName: deriveServiceName(config),
  }
}

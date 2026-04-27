import inquirer from 'inquirer'
import { section, dim, tipBlock, brand } from '../utils/ui.js'
import { createClientFlow, lookupClientStorageChain } from './clientCreator.js'

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
    return collectFrontendOnlyConfig()
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
  }

  // WalletConnect / Reown — frontend-bearing nodes only. Asked here so the
  // operator doesn't bounce between phases.
  const walletConnectProjectId = await collectWalletConnectProjectId(nodeType)

  result.domain = domain
  result.adminPassword = adminPassword
  result.clientId = clientId
  result.storageChain = storageChain
  result.walletConnectProjectId = walletConnectProjectId
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

async function collectFrontendOnlyConfig() {
  section('Frontend Configuration')

  tipBlock([
    'A frontend-only node serves the React app as a static site.',
    'All data comes from an external API hosted by another client.',
  ])

  const { apiUrl } = await inquirer.prompt([
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

  const { domain } = await inquirer.prompt([
    {
      type: 'input',
      name: 'domain',
      message: `Domain name ${dim('(optional, press Enter to skip)')}:`,
      default: ''
    }
  ])

  const walletConnectProjectId = await collectWalletConnectProjectId('frontend-only')

  return { apiUrl, domain, useDocker: false, walletConnectProjectId }
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

import inquirer from 'inquirer'
import { section, dim, tipBlock, brand } from '../utils/ui.js'

export async function collectInfraConfig(nodeType) {
  if (nodeType === 'frontend-only') {
    return collectFrontendOnlyConfig()
  }

  // Infra mode is set by install.sh before we run; we just honor it here.
  // Map the shell's three modes into the legacy `useDocker` value the rest
  // of the CLI passes around.
  //   native   → 'local'   — apt-installed services on 127.0.0.1, defaults are right
  //   docker   → 'docker'  — write docker-compose, prompt for a db password
  //   existing → 'existing' — collect URLs (or honor pre-set env vars)
  const infraMode = process.env.CAW_INFRA_MODE || 'native'
  const useDocker = infraMode === 'native' ? 'local' : infraMode

  let dbUrl = process.env.CAW_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/caw'
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
    dbUrl = `postgresql://postgres:${dbPassword}@127.0.0.1:5432/caw`
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

  // Domain (for nodes that serve HTTP). install.sh asks for the domain
  // before cloning and exports it as CAW_DOMAIN — use that as the default
  // so the user doesn't get asked twice.
  let domain = ''
  let adminPassword = ''
  const envDomain = process.env.CAW_DOMAIN || ''

  if (['full', 'frontend-api', 'api-only'].includes(nodeType)) {
    section('Domain & Access')

    const { hasDomain } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'hasDomain',
        message: 'Do you have a domain name for this node?',
        default: !!envDomain || true,
      }
    ])

    if (hasDomain) {
      const { domainInput } = await inquirer.prompt([
        {
          type: 'input',
          name: 'domainInput',
          message: 'Domain name (e.g., caw.example.com):',
          default: envDomain || undefined,
          validate: (input) => /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(input) ? true : 'Enter a valid domain'
        }
      ])
      domain = domainInput
    } else {
      console.log(dim('  You can set up a domain later with `caw domain`.'))
    }

    // Admin password
    const { adminPw } = await inquirer.prompt([
      {
        type: 'password',
        name: 'adminPw',
        message: 'Admin password (for the admin dashboard):',
        mask: '*',
        validate: (input) => input.length >= 8 ? true : 'Password must be at least 8 characters'
      }
    ])
    adminPassword = adminPw
  }

  // Client ID. Each clientId on-chain scopes a separate sub-network: only
  // posts attributed to that client are visible to its users, and the client
  // owner controls the fees (mint, auth, deposit, withdraw) charged on-chain.
  // Most operators want to join the public network (clientId 1). Creating a
  // new client requires sending an on-chain tx — we don't do that from the
  // installer; we link to docs.
  let clientId = 1

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
      '',
      `${brand('Most operators want clientId 1')} — the public CAW network.`,
      'To create your own, mint one via CawClientManager.createClient (see',
      `the docs at ${brand('https://github.com/GilgameshCaw/Caw#creating-a-client')}).`,
    ])

    const { clientIdInput } = await inquirer.prompt([
      {
        type: 'number',
        name: 'clientIdInput',
        message: `Client ID ${dim('(default: 1 — public network)')}:`,
        default: 1,
        validate: (input) => input > 0 ? true : 'Must be a positive number',
      },
    ])
    clientId = clientIdInput
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
    domain,
    adminPassword,
    clientId,
    apiPort,
  }
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

  return { apiUrl, domain, useDocker: false }
}

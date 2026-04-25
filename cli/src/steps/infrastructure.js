import inquirer from 'inquirer'
import { section, dim, tipBlock, brand } from '../utils/ui.js'

export async function collectInfraConfig(nodeType) {
  if (nodeType === 'frontend-only') {
    return collectFrontendOnlyConfig()
  }

  section('Infrastructure')

  // Database
  tipBlock([
    'CAW uses PostgreSQL for data storage and Redis for caching/pub-sub.',
    'You can use Docker (recommended) or connect to existing instances.',
  ])

  const { useDocker } = await inquirer.prompt([
    {
      type: 'list',
      name: 'useDocker',
      message: 'How do you want to run PostgreSQL and Redis?',
      choices: [
        { value: 'docker', name: `${brand('Docker Compose')} ${dim('(recommended — handles everything)')}` },
        { value: 'existing', name: 'Connect to existing instances' },
        { value: 'local', name: `Local installs ${dim('(already installed on this machine)')}` }
      ]
    }
  ])

  let dbUrl = 'postgresql://postgres:postgres@127.0.0.1:5432/caw'
  let redisUrl = 'redis://127.0.0.1:6379'
  let elasticsearchNode = 'http://127.0.0.1:9200'

  if (useDocker === 'docker') {
    const { dbPassword } = await inquirer.prompt([
      {
        type: 'password',
        name: 'dbPassword',
        message: `PostgreSQL password ${dim('(for the Docker container)')}:`,
        default: 'caw_' + Math.random().toString(36).slice(2, 10),
        mask: '*'
      }
    ])
    dbUrl = `postgresql://postgres:${dbPassword}@127.0.0.1:5432/caw`
  } else if (useDocker === 'existing') {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'dbUrl',
        message: 'PostgreSQL connection URL:',
        default: dbUrl,
        validate: (input) => input.startsWith('postgresql://') ? true : 'Must be a PostgreSQL URL'
      },
      {
        type: 'input',
        name: 'redisUrl',
        message: 'Redis connection URL:',
        default: redisUrl,
        validate: (input) => input.startsWith('redis://') ? true : 'Must be a Redis URL'
      },
      {
        type: 'input',
        name: 'elasticsearchNode',
        message: `Elasticsearch URL ${dim('(search is optional — leave default if unsure)')}:`,
        default: elasticsearchNode,
        validate: (input) => /^https?:\/\//.test(input) ? true : 'Must start with http:// or https://'
      }
    ])
    dbUrl = answers.dbUrl
    redisUrl = answers.redisUrl
    elasticsearchNode = answers.elasticsearchNode
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

  // Client ID
  let clientId = 1

  if (['full', 'frontend-api'].includes(nodeType)) {
    tipBlock([
      'Each CAW frontend has a client ID registered on-chain.',
      'This identifies your frontend to the protocol.',
      'If you don\'t have one yet, use ID 1 (default/shared client) for now.',
    ])

    const { clientIdInput } = await inquirer.prompt([
      {
        type: 'number',
        name: 'clientIdInput',
        message: `Client ID ${dim('(default: 1)')}:`,
        default: 1,
        validate: (input) => input > 0 ? true : 'Must be a positive number'
      }
    ])
    clientId = clientIdInput
  }

  // API port
  const { apiPort } = await inquirer.prompt([
    {
      type: 'number',
      name: 'apiPort',
      message: `API port ${dim('(default: 4000)')}:`,
      default: 4000
    }
  ])

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

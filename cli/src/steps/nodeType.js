import inquirer from 'inquirer'
import { brand, dim, tipBlock, section } from '../utils/ui.js'

const NODE_TYPES = [
  {
    value: 'full',
    name: `${brand.bold('Full Node')} ${dim('(validator + API + frontend)')}`,
    short: 'Full Node',
    description: [
      'Run everything: process transactions, serve the API, host the frontend.',
      'You earn validator tips for processing actions on-chain.',
      'Users connect to your frontend and submit actions through your API.',
      'Maximum contribution to the network — highest decentralization impact.',
    ],
    pros: ['Earn validator tips', 'Serve your own users', 'Full sovereignty over your instance'],
    cons: ['Requires ETH for gas (validator submits L2 transactions)', 'Needs a domain + SSL', 'Highest resource usage (DB, Redis, Node.js)'],
    requires: ['Validator private key (PEM)', 'Client ID', 'L1 + L2 RPC URLs', 'Domain name', 'PostgreSQL', 'Redis', 'Admin tokenId(s)']
  },
  {
    value: 'validator',
    name: `${brand.bold('Validator Only')}`,
    short: 'Validator Only',
    description: [
      'Process transactions and earn tips, without hosting a frontend or API.',
      'You pick up pending actions from the txQueue and submit them on-chain.',
      'Lower infrastructure requirements — no domain needed.',
    ],
    pros: ['Earn validator tips', 'Minimal infrastructure', 'No domain needed'],
    cons: ['Lower priority for receiving transactions (not discoverable as a client)', 'Still need ETH for gas', 'No direct user-facing presence'],
    requires: ['Validator private key (PEM)', 'L1 + L2 RPC URLs', 'PostgreSQL', 'Redis']
  },
  {
    value: 'frontend-api',
    name: `${brand.bold('Frontend + API')} ${dim('(no validator)')}`,
    short: 'Frontend + API',
    description: [
      'Host the web app and API, but delegate transaction processing to validators.',
      'Users post through your frontend, actions go to the txQueue,',
      'and external validators pick them up and submit on-chain.',
      'Great for building a branded CAW experience without validator overhead.',
    ],
    pros: ['Serve your own users', 'No ETH needed for gas', 'Lower operational risk'],
    cons: ['No validator tip income', 'Depends on external validators to process actions', 'Still need DB + domain'],
    requires: ['Client ID', 'L2 RPC URL', 'Domain name', 'PostgreSQL', 'Redis', 'Admin tokenId(s)']
  },
  {
    value: 'frontend-only',
    name: `${brand.bold('Frontend Only')} ${dim('(static site)')}`,
    short: 'Frontend Only',
    description: [
      'Just the React web app, pointed at an external API.',
      'The cheapest option — no backend, no database, no validator.',
      'Perfect for contributing to decentralized access with minimal cost.',
      'Users see your frontend but all data comes from another client\'s API.',
    ],
    pros: ['Cheapest to run (static hosting)', 'No backend infrastructure', 'Easy to set up'],
    cons: ['No tip income', 'Depends entirely on an external API', 'Limited control over data/moderation'],
    requires: ['External API URL', 'Static hosting (or a domain)']
  },
  {
    value: 'api-only',
    name: `${brand.bold('API Only')} ${dim('(headless)')}`,
    short: 'API Only',
    description: [
      'Run the API server without a frontend.',
      'Other frontends (or mobile apps) connect to your API for data.',
      'Good for building custom UIs or serving multiple frontends.',
    ],
    pros: ['Serve multiple frontends', 'Headless — flexible integration', 'Can combine with a validator for full backend'],
    cons: ['No user-facing frontend', 'Need DB + Redis', 'No direct user traffic unless frontends point at you'],
    requires: ['L2 RPC URL', 'PostgreSQL', 'Redis', 'Admin tokenId(s)']
  }
]

export async function selectNodeType() {
  section('What would you like to run?')

  // install.sh asks the same question before bootstrapping system packages
  // (it skips postgres/redis/elasticsearch for frontend-only, etc.). When
  // the operator answers there, install.sh re-execs the CLI with
  // CAW_NODE_TYPE in the environment so we don't double-prompt.
  const fromEnv = process.env.CAW_NODE_TYPE
  if (fromEnv && NODE_TYPES.some(t => t.value === fromEnv)) {
    const selected = NODE_TYPES.find(t => t.value === fromEnv)
    console.log(dim(`  Using ${brand.bold(selected.short)} (from CAW_NODE_TYPE)`))
    return fromEnv
  }

  const { nodeType } = await inquirer.prompt([
    {
      type: 'list',
      name: 'nodeType',
      message: 'Select your node type:',
      choices: NODE_TYPES.map(t => ({ value: t.value, name: t.name, short: t.short })),
      pageSize: 10
    }
  ])

  const selected = NODE_TYPES.find(t => t.value === nodeType)

  // Show description and tradeoffs
  console.log()
  for (const line of selected.description) {
    console.log(dim(`  ${line}`))
  }

  tipBlock([
    `${brand('Pros:')} ${selected.pros.join(', ')}`,
    `${brand('Cons:')} ${selected.cons.join(', ')}`,
    '',
    `${brand('Requires:')} ${selected.requires.join(', ')}`
  ])

  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: `Proceed with ${brand.bold(selected.short)}?`,
      default: true
    }
  ])

  if (!confirm) {
    return selectNodeType() // Let them pick again
  }

  return nodeType
}

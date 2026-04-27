import inquirer from 'inquirer'
import { section, dim, tipBlock, brand } from '../utils/ui.js'

/**
 * Ask which network and deployment mode the operator wants. Runs before
 * RPC and infra so downstream prompts can label themselves correctly
 * (e.g. "Base Sepolia" vs "Base") and skip questions that don't apply.
 */
export async function collectNetworkAndMode(nodeType) {
  // Network — drives chain IDs, contract addresses, and indexer behavior.
  section('Network')
  tipBlock([
    'Pick the network this node will run against.',
    'Most public installs run testnet — it has no real funds at stake.',
  ])
  const { network } = await inquirer.prompt([
    {
      type: 'list',
      name: 'network',
      message: 'Which network?',
      choices: [
        { value: 'testnet', name: `${brand('Testnet')} ${dim('(Sepolia chains)')}` },
        { value: 'mainnet', name: `${brand('Mainnet')} ${dim('(Ethereum + L2s)')}` },
      ],
      default: 'testnet',
    },
  ])

  // Deployment mode — drives whether we run vite dev or build the frontend
  // and let nginx serve dist/. Ask early because subsequent steps branch on it.
  let deployment = 'dev'
  if (['full', 'frontend-api', 'frontend-only', 'api-only'].includes(nodeType)) {
    section('Deployment Mode')
    const { mode } = await inquirer.prompt([
      {
        type: 'list',
        name: 'mode',
        message: 'How are you running this node?',
        choices: [
          { value: 'production', name: `${brand('Production')} ${dim('(public domain, nginx serves built frontend)')}` },
          { value: 'dev', name: `${brand('Development')} ${dim('(localhost, vite dev server)')}` },
        ],
        default: 'production',
      },
    ])
    deployment = mode
  }

  return { network, deployment }
}

/**
 * Human-readable chain labels for prompts. Keep in lockstep with NETWORKS in
 * generate.js — both encode the same fact.
 */
export function chainLabels(network) {
  if (network === 'mainnet') {
    return { l1: 'L1 (Ethereum Mainnet)', l2: 'L2 (Base)' }
  }
  return { l1: 'L1 (Ethereum Sepolia)', l2: 'L2 (Base Sepolia)' }
}

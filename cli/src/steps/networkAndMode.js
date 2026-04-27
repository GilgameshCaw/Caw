import inquirer from 'inquirer'
import { section, dim, tipBlock, brand } from '../utils/ui.js'

/**
 * Ask which network and deployment mode the operator wants. Runs before
 * RPC and infra so downstream prompts can label themselves correctly
 * (e.g. "Base Sepolia" vs "Base") and skip questions that don't apply.
 */
export async function collectNetworkAndMode(nodeType) {
  // Network — drives chain IDs, contract addresses, and indexer behavior.
  // Mainnet is gated behind CAW_ALLOW_MAINNET while we're in testnet-only
  // launch phase. Removes the option from the picker entirely so operators
  // can't pick a network whose contracts haven't shipped yet.
  section('Network')
  const allowMainnet = process.env.CAW_ALLOW_MAINNET === '1'
  let network
  if (allowMainnet) {
    tipBlock([
      'Pick the network this node will run against.',
      'Most public installs run testnet — it has no real funds at stake.',
    ])
    const answer = await inquirer.prompt([
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
    network = answer.network
  } else {
    network = 'testnet'
    tipBlock([
      `Running against ${brand('testnet')} (Sepolia chains).`,
      'Mainnet is coming soon — testnet is the only target right now.',
    ])
  }

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
 * Human-readable chain labels for prompts. The L1 is fixed (Ethereum) but
 * the L2 is whichever chain the operator's target client stores on (Base,
 * Arbitrum, …) — we don't know which until later, so the L2 label stays
 * generic. Keep in lockstep with NETWORKS in generate.js.
 */
export function chainLabels(network) {
  if (network === 'mainnet') {
    return { l1: 'L1 (Ethereum Mainnet)', l2: 'L2 (your client\'s storage chain)' }
  }
  return { l1: 'L1 (Ethereum Sepolia)', l2: 'L2 Sepolia (your client\'s storage chain)' }
}

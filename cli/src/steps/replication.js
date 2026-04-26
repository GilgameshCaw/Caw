import inquirer from 'inquirer'
import crypto from 'crypto'
import { section, dim, tipBlock, brand, success, warn, err } from '../utils/ui.js'

// Replication chain options. Each entry maps to one archive chain that the
// optimistic-archive contracts have been deployed to. We pick by network
// (testnet/mainnet) so operators see only the chains that exist for their
// chosen environment. The label/cta/lzEid are wedged in here so we can
// surface useful info in prompts later (gas comparisons, etc.).
const REPLICATION_CHAINS = {
  testnet: [
    {
      key: 'arbitrum-sepolia',
      label: 'Arbitrum Sepolia',
      hint: 'cheapest, fastest finality — recommended for testnet',
    },
    // Future: optimism-sepolia, polygon-amoy, etc. Add as deployments land.
  ],
  mainnet: [
    {
      key: 'arbitrum-one',
      label: 'Arbitrum One',
      hint: 'cheapest L2 by gas, most-deployed CAW archive',
    },
    // Future entries gated on actually-deployed contracts. Don't list a chain
    // here unless CawActionsArchive is live on it.
  ],
}

/**
 * Optional replication participation. Replication is the optimistic-archive
 * fraud-detection layer: validators that opt in commit a hash of each batch
 * to an archive chain and watch for incorrect submissions from peers,
 * winning slashing rewards if they catch fraud.
 *
 * Each client picks its own replication destinations on-chain (via
 * CawClientManager.addReplication). The validator just needs (a) an RPC for
 * one of those chains and (b) a key with ETH on that chain to submit batch
 * hashes and challenges.
 *
 * Two env vars come out of this step:
 *   REPLICATION_RPC        — RPC URL for the chosen archive chain
 *   REPLICATION_CHAIN      — short key identifying which chain (e.g.
 *                            "arbitrum-sepolia"); ValidatorService picks
 *                            the contract address by this key.
 *   REPLICATOR_PRIVATE_KEY — separate key for the submitter wallet. When
 *                            unset, ValidatorService falls back to the main
 *                            validator key. We recommend separate keys so a
 *                            compromise of one is contained.
 *
 * Skipped when nodeType isn't full or validator.
 */
export async function collectReplicationConfig(nodeType, ctx = {}) {
  if (!['full', 'validator'].includes(nodeType)) return {}

  section('Replication (optional)')

  tipBlock([
    `${brand('What is replication?')}`,
    'CAW archives every batch of actions to a separate chain (today: Arbitrum',
    'Sepolia for testnet, Arbitrum mainnet for prod). Validators that opt in',
    'commit a hash of each batch and watch for incorrect submissions from',
    'peers. If you catch a peer committing fraud, you slash their stake and',
    'collect the reward.',
    '',
    `${brand('What does it cost?')}`,
    '  • An ETH balance on the archive chain (~$1/month at typical volume)',
    '  • A bit of validator runtime (one extra background loop)',
    '',
    `${brand('Should I enable it?')}`,
    '  Optional. The protocol works either way. Enabling improves the network\'s',
    '  fraud-detection coverage and may earn you slashing rewards.',
  ])

  const { participate } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'participate',
      message: 'Participate in replication?',
      default: false,
    },
  ])

  if (!participate) {
    console.log(dim('  Skipping replication setup — you can enable it later by setting'))
    console.log(dim('  REPLICATION_RPC, REPLICATION_CHAIN, and (optionally)'))
    console.log(dim('  REPLICATOR_PRIVATE_KEY in client/.env.'))
    return {}
  }

  // ---- Archive chain selection ----
  const network = ctx.network || 'testnet'
  const chains = REPLICATION_CHAINS[network] || []
  if (chains.length === 0) {
    console.log(warn(`  No replication chains are deployed yet for ${network}.`))
    return {}
  }

  console.log()
  tipBlock([
    'Pick the chain you want to replicate to. Different clients can choose',
    'different chains; if you run for multiple clients, pick the one your',
    'primary client uses (you can run extra replicators on other chains',
    'later by adding more env config).',
  ])

  let replicationChain
  if (chains.length === 1) {
    // Single-chain shortcut: don't make the operator pick from a list of one.
    replicationChain = chains[0].key
    console.log(dim(`  Using ${chains[0].label} (only chain available on ${network}).`))
  } else {
    const answer = await inquirer.prompt([
      {
        type: 'list',
        name: 'chainKey',
        message: 'Replication chain:',
        choices: chains.map(c => ({
          value: c.key,
          name: `${brand(c.label)} ${dim('— ' + c.hint)}`,
        })),
        default: chains[0].key,
      },
    ])
    replicationChain = answer.chainKey
  }
  const chosenChain = chains.find(c => c.key === replicationChain)

  console.log()
  tipBlock([
    `Replication chain: ${brand(chosenChain.label)}`,
    'You need an HTTP RPC URL for this chain. Free tiers from Infura,',
    'Alchemy, or QuickNode all work.',
  ])

  const { replicationRpcUrl } = await inquirer.prompt([
    {
      type: 'input',
      name: 'replicationRpcUrl',
      message: `${chosenChain.label} HTTP RPC URL:`,
      validate: (input) => {
        if (!input.trim()) return 'Required'
        if (!/^https?:\/\//.test(input)) return 'Must start with http:// or https://'
        return true
      },
    },
  ])

  // ---- Replicator key ----
  console.log()
  tipBlock([
    `${brand('Replicator key')}`,
    'The replicator submits batch-hash commitments to the archive chain.',
    'You can use the same key as your main validator, or a separate one.',
    '',
    `${brand('Recommendation:')} use a separate key. If either gets compromised,`,
    'the blast radius is contained — the validator key only authorizes L2',
    'submissions; a separate replicator key only authorizes archive-chain',
    'submissions.',
  ])

  const { keyChoice } = await inquirer.prompt([
    {
      type: 'list',
      name: 'keyChoice',
      message: 'Replicator key:',
      choices: [
        { value: 'separate-generate', name: `${brand('Generate a new replicator key')} ${dim('(recommended)')}` },
        { value: 'separate-import', name: 'Import an existing replicator private key' },
        { value: 'reuse', name: `${brand('Reuse the validator key')} ${dim('(simpler, less isolation)')}` },
      ],
      default: 'separate-generate',
    },
  ])

  let replicatorPrivateKey

  if (keyChoice === 'reuse') {
    // Don't write REPLICATOR_PRIVATE_KEY at all — ValidatorService falls
    // back to the validator key when the var is missing. Cleaner than
    // duplicating the validator key into REPLICATOR_PRIVATE_KEY.
    replicatorPrivateKey = undefined
    console.log(dim('  ✓ Replicator will reuse the validator key.'))
  } else if (keyChoice === 'separate-generate') {
    replicatorPrivateKey = '0x' + crypto.randomBytes(32).toString('hex')
    const { computeAddress } = await importEthersUtils()
    const address = computeAddress(replicatorPrivateKey)

    // Same opt-in pattern as the validator key: address is safe to print
    // (you have to fund it); the secret key is only shown if the operator
    // explicitly asks for it. It always lives in client/.env regardless.
    console.log()
    console.log(success('  New replicator key generated!'))
    console.log()
    console.log(brand('  Address: ') + address)
    console.log(err.bold(`  Fund ${address} with ETH on ${chosenChain.label} — pays gas for batch submissions and challenges.`))
    console.log()

    const { showKey } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'showKey',
        message: 'Print the private key now so you can back it up?',
        default: false,
      },
    ])
    if (showKey) {
      console.log()
      console.log(warn('  Private key: ') + dim(replicatorPrivateKey))
      console.log(err.bold('  IMPORTANT: Copy this somewhere safe. It cannot be recovered.'))
      console.log(dim('  (Also lives at client/.env on this server — readable only by the caw user.)'))
      console.log()
      await inquirer.prompt([{ type: 'confirm', name: 'ok', message: 'Saved? Continue.', default: true }])
    } else {
      console.log(dim('  Skipped. The key is in client/.env if you need it later.'))
    }
  } else {
    const { importedKey } = await inquirer.prompt([
      {
        type: 'password',
        name: 'importedKey',
        message: 'Replicator private key (hex, with or without 0x prefix):',
        mask: '*',
        validate: (input) => {
          const hex = input.startsWith('0x') ? input.slice(2) : input
          return /^[0-9a-fA-F]{64}$/.test(hex) ? true : 'Invalid private key (must be 64 hex chars)'
        },
      },
    ])
    replicatorPrivateKey = importedKey.startsWith('0x') ? importedKey : '0x' + importedKey
  }

  return {
    replicationRpcUrl,
    replicationChain,
    replicatorPrivateKey,
    replicationEnabled: true,
  }
}

async function importEthersUtils() {
  try {
    const ethers = await import('ethers')
    return { computeAddress: ethers.computeAddress }
  } catch {
    return { computeAddress: () => '(install ethers to see address)' }
  }
}

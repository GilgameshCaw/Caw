import inquirer from 'inquirer'
import crypto from 'crypto'
import { section, dim, tipBlock, brand, success, warn, err } from '../utils/ui.js'

/**
 * Optional replication participation. Replication is the optimistic-archive
 * fraud-detection layer: validators that opt in commit a hash of each batch to
 * an archive chain (Arbitrum Sepolia today), and watch for incorrect
 * submissions from peers — winning slashing rewards if they catch fraud.
 *
 * Two env vars come out of this step:
 *   RPC_ARBITRUM_SEPOLIA   — RPC URL for the archive chain (always required
 *                            when replication is enabled)
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
    console.log(dim('  RPC_ARBITRUM_SEPOLIA (and optionally REPLICATOR_PRIVATE_KEY) in client/.env.'))
    return {}
  }

  // ---- Archive chain RPC ----
  // Today only Arbitrum Sepolia (testnet) and mainnet equivalent are
  // supported; the contracts pick the chain so we just need an RPC URL for it.
  const archiveLabel = ctx.network === 'mainnet'
    ? 'Arbitrum One (mainnet)'
    : 'Arbitrum Sepolia (testnet)'

  console.log()
  tipBlock([
    `Replication archive chain: ${brand(archiveLabel)}`,
    'You need an HTTP RPC URL for this chain. Free tiers from Infura,',
    'Alchemy, or QuickNode all work.',
  ])

  const { archiveRpcUrl } = await inquirer.prompt([
    {
      type: 'input',
      name: 'archiveRpcUrl',
      message: `${archiveLabel} HTTP RPC URL:`,
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
    console.log()
    console.log(success('  New replicator key generated!'))
    console.log()
    console.log(brand('  Address: ') + address)
    console.log(warn('  Private key: ') + dim(replicatorPrivateKey))
    console.log()
    console.log(err.bold('  IMPORTANT: Back up this private key. Fund the address above with ETH'))
    console.log(err.bold(`  on ${archiveLabel} (used for tx fees on submissions and challenges).`))
    console.log()
    const { backedUp } = await inquirer.prompt([
      { type: 'confirm', name: 'backedUp', message: 'Have you saved the private key?', default: false },
    ])
    if (!backedUp) {
      console.log(warn(`  Replicator private key: ${replicatorPrivateKey}`))
      await inquirer.prompt([{ type: 'confirm', name: 'ok', message: 'Ready to continue?', default: true }])
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
    archiveRpcUrl,
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

import inquirer from 'inquirer'
import crypto from 'crypto'
import { section, dim, tipBlock, brand, success, warn, err } from '../utils/ui.js'
import { addr } from '../addresses.js'

// Just enough ABI to look up token IDs and owners.
const MINTER_ABI = [
  'function idByUsername(string) view returns (uint32)',
]
const PROFILE_ABI = [
  'function ownerOf(uint256) view returns (address)',
]

export async function collectValidatorConfig(nodeType, installDir, ctx = {}) {
  if (!['full', 'validator'].includes(nodeType)) return {}

  section('Validator Configuration')

  tipBlock([
    'The validator needs a private key to sign and submit transactions on L2.',
    'This key will hold ETH on Base (for gas fees) and be used to submit',
    'batched user actions on-chain. Validator tips are paid to the wallet that',
    'owns the validator username NFT (asked next), not to this signing key.',
    '',
    'Options:',
    '  1. Generate a new key (recommended for fresh installs)',
    '  2. Import an existing private key (hex format)',
  ])

  const { keySource } = await inquirer.prompt([
    {
      type: 'list',
      name: 'keySource',
      message: 'Validator private key:',
      choices: [
        { value: 'generate', name: `${brand('Generate new key')} ${dim('(recommended)')}` },
        { value: 'import', name: 'Import existing private key' },
      ],
    },
  ])

  let privateKey

  if (keySource === 'generate') {
    privateKey = '0x' + crypto.randomBytes(32).toString('hex')
    const { computeAddress } = await importEthersUtils()
    const address = computeAddress(privateKey)

    // The address is safe to print always — that's how you fund the key.
    // The private key is shown only if the operator explicitly asks. The
    // key always lives in client/.env (chmod 600, owned by caw), so a
    // power-user who wants to back it up can read it from there later.
    console.log()
    console.log(success('  New validator key generated!'))
    console.log()
    console.log(brand('  Address: ') + address)
    console.log(err.bold(`  Fund ${address} with ETH on Base — this address pays gas for every action you submit.`))
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
      console.log(warn('  Private key: ') + dim(privateKey))
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
        message: 'Enter private key (hex, with or without 0x prefix):',
        mask: '*',
        validate: (input) => {
          const hex = input.startsWith('0x') ? input.slice(2) : input
          if (!/^[0-9a-fA-F]{64}$/.test(hex)) return 'Invalid private key (must be 64 hex characters)'
          return true
        },
      },
    ])
    privateKey = importedKey.startsWith('0x') ? importedKey : '0x' + importedKey
  }

  // ----- Validator username (and on-chain lookup of tokenId + owner) -----
  console.log()
  tipBlock([
    'Each validator is identified by a CawName username NFT.',
    '',
    `${brand('Validator tips are paid in CAW to the wallet that OWNS that username.')}`,
    'If you transfer the username to another wallet, tips follow it. The signing',
    'key above is just for submitting transactions and does not receive tips.',
    '',
    'Type the username (no @, no .caw — just the name) and we\'ll look up the',
    'token ID and owner address on-chain to confirm.',
  ])

  const validatorId = await resolveValidatorByUsername(ctx)

  // ----- Poll interval -----
  console.log()
  tipBlock([
    'How often should the validator check the TxQueue (the queue of pending',
    'user actions waiting to be submitted on-chain)?',
    '',
    `Lower = lower latency for users, more RPC calls. ${brand('3000ms')} is the default.`,
    'Don\'t go below 1000ms — RPC providers will rate-limit you.',
  ])

  const { checkInterval } = await inquirer.prompt([
    {
      type: 'number',
      name: 'checkInterval',
      message: `TxQueue poll interval in ms ${dim('(default: 3000)')}:`,
      default: 3000,
      validate: (input) => input >= 1000 ? true : 'Minimum 1000ms',
    },
  ])

  return { validatorPrivateKey: privateKey, validatorId, checkInterval }
}

/**
 * Ask the operator how they want to identify their validator (by username
 * with on-chain lookup, or by token ID directly), then collect + verify.
 * Using a separate menu prompt avoids the username/sentinel collision
 * problem — usernames are `[a-z0-9]+` on-chain so any sentinel string we
 * picked could in principle collide with a real username.
 */
async function resolveValidatorByUsername(ctx) {
  const { l1RpcUrl } = ctx
  const minter = addr('CAW_NAMES_MINTER_ADDRESS')
  const profile = addr('CAW_NAMES_ADDRESS')

  // Up-front choice: lookup vs direct entry. Default is username lookup
  // when we have an L1 RPC; falls back to direct entry otherwise.
  const lookupAvailable = !!l1RpcUrl
  const choices = [
    {
      value: 'username',
      name: lookupAvailable
        ? `${brand('By username')} ${dim('(recommended — looks up tokenId on-chain)')}`
        : `${brand('By username')} ${dim('(unavailable — no L1 RPC)')}`,
      disabled: lookupAvailable ? false : 'Provide an L1 RPC URL earlier in the install',
    },
    { value: 'tokenId', name: 'By token ID directly' },
  ]
  const { method } = await inquirer.prompt([
    {
      type: 'list',
      name: 'method',
      message: 'How do you want to identify your validator?',
      choices,
      default: lookupAvailable ? 'username' : 'tokenId',
    },
  ])

  if (method === 'tokenId') {
    const { tokenId } = await inquirer.prompt([
      {
        type: 'number',
        name: 'tokenId',
        message: 'Validator token ID:',
        validate: (input) => input > 0 ? true : 'Token ID must be a positive number',
      },
    ])
    return tokenId
  }

  // Username lookup — loop until the operator either confirms a result or
  // bails back to the menu.
  while (true) {
    const { username } = await inquirer.prompt([
      {
        type: 'input',
        name: 'username',
        message: 'Validator username:',
        validate: (input) => {
          const v = input.trim()
          if (!v) return 'Required'
          // CawNames are 1-255 lowercase alphanumerics on-chain. We don't
          // enforce the upper bound here; let the lookup just return 0.
          if (!/^[a-z0-9]+$/.test(v)) return 'Username must be lowercase letters and numbers only'
          return true
        },
      },
    ])

    let tokenId, owner
    try {
      const { JsonRpcProvider, Contract } = await import('ethers')
      const provider = new JsonRpcProvider(l1RpcUrl)
      const minterContract = new Contract(minter, MINTER_ABI, provider)
      const profileContract = new Contract(profile, PROFILE_ABI, provider)

      const id = await minterContract.idByUsername(username.trim())
      tokenId = Number(id)
      if (tokenId === 0) {
        console.log(err(`  No token found for username "${username}".`))
        console.log(dim('  Check the spelling and try again.'))
        console.log()
        continue
      }
      owner = await profileContract.ownerOf(tokenId)
    } catch (e) {
      console.log(err(`  Lookup failed: ${e?.message || e}`))
      console.log(dim('  Try a different username, or restart the install with a working L1 RPC.'))
      console.log()
      continue
    }

    console.log()
    console.log(success(`  Found ${brand(username)}:`))
    console.log(`    Token ID:     ${brand(String(tokenId))}`)
    console.log(`    Owner wallet: ${brand(owner)}`)
    console.log()
    console.log(warn(`  Validator tips for this node will be paid to ${owner}.`))
    console.log()

    const { confirmed } = await inquirer.prompt([
      { type: 'confirm', name: 'confirmed', message: 'Use this validator identity?', default: true },
    ])
    if (confirmed) return tokenId
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

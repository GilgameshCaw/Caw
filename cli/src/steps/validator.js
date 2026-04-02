import inquirer from 'inquirer'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { section, dim, tipBlock, brand, success, warn, err } from '../utils/ui.js'

export async function collectValidatorConfig(nodeType, installDir) {
  if (!['full', 'validator'].includes(nodeType)) return {}

  section('Validator Configuration')

  tipBlock([
    'The validator needs a private key to sign and submit transactions on L2.',
    'This key will hold ETH on Base (for gas fees) and earn CAW tips.',
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
        { value: 'import', name: 'Import existing private key' }
      ]
    }
  ])

  let privateKey

  if (keySource === 'generate') {
    privateKey = '0x' + crypto.randomBytes(32).toString('hex')
    // Derive address for display
    const { computeAddress } = await importEthersUtils()
    const address = computeAddress(privateKey)

    console.log()
    console.log(success('  New validator key generated!'))
    console.log()
    console.log(brand('  Address: ') + address)
    console.log(warn('  Private key: ') + dim(privateKey))
    console.log()
    console.log(err.bold('  IMPORTANT: Back up this private key! It cannot be recovered.'))
    console.log(err.bold(`  You need to fund ${address} with ETH on Base for gas.`))
    console.log()

    const { backedUp } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'backedUp',
        message: 'Have you saved the private key?',
        default: false
      }
    ])

    if (!backedUp) {
      console.log(warn('  Please save the private key before continuing.'))
      console.log(warn(`  Private key: ${privateKey}`))
      await inquirer.prompt([{ type: 'confirm', name: 'ok', message: 'Ready to continue?', default: true }])
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
        }
      }
    ])
    privateKey = importedKey.startsWith('0x') ? importedKey : '0x' + importedKey
  }

  // Validator ID (token ID)
  console.log()
  tipBlock([
    'Each validator needs a CAW username (NFT token) to identify itself.',
    'The token ID is the numeric ID of your CawName NFT.',
    'If you don\'t have one yet, you\'ll need to mint one first (Phase 2 feature).',
  ])

  const { validatorId } = await inquirer.prompt([
    {
      type: 'number',
      name: 'validatorId',
      message: 'Validator token ID (your CawName NFT ID):',
      validate: (input) => {
        if (!input || input <= 0) return 'Token ID must be a positive number'
        return true
      }
    }
  ])

  // Validator tip
  tipBlock([
    'The minimum tip is the CAW amount you require per action to cover gas.',
    'Higher tips = you process more actions (users pay you more).',
    'Lower tips = you process cheaper actions but earn less per action.',
    '',
    'Default: 1000 CAW base + 500 CAW per replication chain',
    'At current prices, 1000 CAW ~ $0.02',
  ])

  const { checkInterval } = await inquirer.prompt([
    {
      type: 'number',
      name: 'checkInterval',
      message: `TxQueue poll interval in ms ${dim('(default: 3000)')}:`,
      default: 3000,
      validate: (input) => input >= 1000 ? true : 'Minimum 1000ms'
    }
  ])

  return { validatorPrivateKey: privateKey, validatorId, checkInterval }
}

async function importEthersUtils() {
  try {
    const ethers = await import('ethers')
    return { computeAddress: ethers.computeAddress }
  } catch {
    // Fallback: can't compute address without ethers
    return {
      computeAddress: () => '(install ethers to see address)'
    }
  }
}

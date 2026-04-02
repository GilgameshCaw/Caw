import inquirer from 'inquirer'
import { section, dim, tipBlock, brand, warn } from '../utils/ui.js'

export async function collectRpcUrls(nodeType) {
  section('RPC Endpoints')

  tipBlock([
    'CAW uses Ethereum L1 (mainnet) and Base L2 for operations.',
    'You need RPC endpoints to read/write blockchain data.',
    '',
    'Free options: Infura, Alchemy, QuickNode (all have free tiers)',
    'For validators: WebSocket (wss://) URLs are preferred for real-time events.',
    'For API-only nodes: HTTP (https://) URLs work fine.',
  ])

  const needsL1 = ['full', 'validator'].includes(nodeType)
  const needsL2 = nodeType !== 'frontend-only'

  const prompts = []

  if (needsL2) {
    prompts.push({
      type: 'input',
      name: 'l2RpcUrl',
      message: 'L2 RPC URL (Base Sepolia — wss:// preferred for validators):',
      validate: (input) => {
        if (!input.trim()) return 'L2 RPC URL is required'
        if (!input.startsWith('wss://') && !input.startsWith('https://') && !input.startsWith('http://')) {
          return 'URL must start with wss://, https://, or http://'
        }
        return true
      }
    })

    // Optional HTTP fallback if they gave a WebSocket URL
    prompts.push({
      type: 'input',
      name: 'l2RpcUrlHttp',
      message: `L2 HTTP RPC URL ${dim('(optional — for polling fallback, press Enter to auto-derive)')}:`,
      default: '',
    })
  }

  if (needsL1) {
    prompts.push({
      type: 'input',
      name: 'ethMainnetRpcUrl',
      message: `Ethereum L1 RPC URL ${dim('(mainnet — for Uniswap price feeds)')}:`,
      validate: (input) => {
        if (!input.trim()) return 'L1 RPC URL is required for validators (used for CAW/ETH price conversion)'
        if (!input.startsWith('https://') && !input.startsWith('http://') && !input.startsWith('wss://')) {
          return 'URL must start with https://, http://, or wss://'
        }
        return true
      }
    })
  }

  const answers = await inquirer.prompt(prompts)

  // Auto-derive HTTP URL from WebSocket if not provided
  if (answers.l2RpcUrl && !answers.l2RpcUrlHttp) {
    answers.l2RpcUrlHttp = answers.l2RpcUrl
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://')
      .replace(/\/ws\//, '/')
  }

  if (answers.l2RpcUrl?.startsWith('http') && !answers.l2RpcUrl?.startsWith('wss')) {
    console.log(warn('  Note: HTTP RPC URLs work but WebSocket (wss://) is recommended for real-time event streaming.'))
  }

  return answers
}

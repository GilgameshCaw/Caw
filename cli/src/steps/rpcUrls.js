import inquirer from 'inquirer'
import { section, dim, tipBlock } from '../utils/ui.js'
import { chainLabels } from './networkAndMode.js'

/**
 * Infer the HTTP URL from a WebSocket URL.
 * Handles Infura's /ws/ path segment; safe for other providers.
 */
function inferHttpFromWs(wsUrl) {
  return wsUrl
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://')
    .replace(/(\.infura\.io)\/ws\/(v\d+\/)/, '$1/$2')
}

function inferWsFromHttp(httpUrl) {
  let ws = httpUrl
    .replace(/^https:\/\//, 'wss://')
    .replace(/^http:\/\//, 'ws://')
  // Infura: insert /ws/ before the version segment
  ws = ws.replace(/(\.infura\.io)\/(v\d+\/)/, '$1/ws/$2')
  return ws
}

function isInfuraUrl(url) {
  return /\.infura\.io[/]/.test(url)
}

/**
 * Collect a WSS + HTTP RPC pair for a chain.
 * If the user provides an Infura URL, the other format is auto-derived
 * without prompting. For other providers, both are asked.
 */
async function collectRpcPair(label, required) {
  const { url } = await inquirer.prompt([{
    type: 'input',
    name: 'url',
    message: `${label} RPC URL (wss:// or https://):`,
    validate: (input) => {
      if (!input.trim()) {
        return required ? `${label} RPC URL is required` : true
      }
      if (!input.startsWith('wss://') && !input.startsWith('ws://') &&
          !input.startsWith('https://') && !input.startsWith('http://')) {
        return 'URL must start with wss://, ws://, https://, or http://'
      }
      return true
    }
  }])

  if (!url.trim()) return { wss: '', http: '' }

  const isWs = url.startsWith('wss://') || url.startsWith('ws://')

  if (isInfuraUrl(url)) {
    const wss = isWs ? url : inferWsFromHttp(url)
    const http = isWs ? inferHttpFromWs(url) : url
    console.log(dim(`  ✓ Infura detected — derived both endpoints:`))
    console.log(dim(`    WSS:  ${wss.slice(0, 55)}...`))
    console.log(dim(`    HTTP: ${http.slice(0, 55)}...`))
    return { wss, http }
  }

  // Not Infura — ask for the other format
  if (isWs) {
    const { http } = await inquirer.prompt([{
      type: 'input',
      name: 'http',
      message: `${label} HTTP RPC URL (https://):`,
      default: inferHttpFromWs(url),
    }])
    return { wss: url, http }
  } else {
    const { wss } = await inquirer.prompt([{
      type: 'input',
      name: 'wss',
      message: `${label} WebSocket RPC URL (wss://):`,
      default: inferWsFromHttp(url),
    }])
    return { wss, http: url }
  }
}

export async function collectRpcUrls(nodeType, network = 'testnet') {
  section('RPC Endpoints')

  const labels = chainLabels(network)
  tipBlock([
    `CAW uses Ethereum L1 and Base L2 for operations on ${network === 'mainnet' ? 'mainnet' : 'testnet'}.`,
    'You need both WebSocket (wss://) and HTTP (https://) endpoints.',
    '',
    'Free options: Infura, Alchemy, QuickNode (all have free tiers)',
    'If you provide an Infura URL, the other format is auto-derived.',
  ])

  const needsL1 = ['full', 'validator'].includes(nodeType)
  const needsL2 = nodeType !== 'frontend-only'

  const answers = {}

  if (needsL2) {
    const l2 = await collectRpcPair(labels.l2, true)
    answers.l2RpcUrl = l2.wss
    answers.l2RpcUrlHttp = l2.http
  }

  if (needsL1) {
    const l1 = await collectRpcPair(labels.l1, true)
    answers.l1RpcUrl = l1.wss
    answers.l1RpcUrlHttp = l1.http

    // Mainnet RPC (for price feeds) — HTTP only
    const { ethMainnetRpcUrl } = await inquirer.prompt([{
      type: 'input',
      name: 'ethMainnetRpcUrl',
      message: `Ethereum Mainnet RPC URL ${dim('(for Uniswap price feeds — https://)')}:`,
      validate: (input) => {
        if (!input.trim()) return 'Mainnet RPC URL is required for validators (CAW/ETH price conversion)'
        if (!input.startsWith('https://') && !input.startsWith('http://')) {
          return 'URL must start with https:// or http://'
        }
        return true
      }
    }])
    answers.ethMainnetRpcUrl = ethMainnetRpcUrl
  }

  return answers
}

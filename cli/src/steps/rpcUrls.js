import inquirer from 'inquirer'
import { section, dim, tipBlock } from '../utils/ui.js'
import { chainLabels } from './networkAndMode.js'

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
 * Collect an HTTP (required) + WSS (optional) RPC pair for a chain.
 *
 * HTTP carries every read and every tx submission — required, no fallback.
 * WSS is only used for live event subscription, which is disabled by default
 * in production (see ENABLE_RAW_EVENTS_WS / ENABLE_VALIDATOR_WS — services
 * fall back to HTTP polling when WSS isn't set). So we ask for HTTP first
 * and treat WSS as a leave-blank-to-skip optional.
 *
 * Infura is the one provider where the two URLs are reliably interchangeable
 * (just swap the protocol + insert /ws/), so when we see one Infura URL we
 * offer to fill the other automatically. For every other provider we don't
 * guess — guessing produced unreachable URLs that the user accepted by
 * hitting Enter.
 */
async function collectRpcPair(label, required) {
  // Step 1: HTTP URL (required for the chain to function at all).
  const { http } = await inquirer.prompt([{
    type: 'input',
    name: 'http',
    message: `${label} HTTP RPC URL (https://):`,
    validate: (input) => {
      if (!input.trim()) {
        return required ? `${label} HTTP RPC URL is required` : true
      }
      if (!input.startsWith('https://') && !input.startsWith('http://')) {
        return 'URL must start with https:// or http://'
      }
      return true
    },
  }])

  if (!http.trim()) return { wss: '', http: '' }

  // Step 2: WSS URL (optional). When the HTTP URL is Infura, offer the
  // auto-derived WSS as a default; otherwise leave blank — most providers
  // either give you a separate WSS URL or don't expose one at all.
  const isInfura = isInfuraUrl(http)
  const wssDefault = isInfura ? inferWsFromHttp(http) : ''

  const { wss } = await inquirer.prompt([{
    type: 'input',
    name: 'wss',
    message: `${label} WebSocket RPC URL ${dim('(optional — leave blank to skip; HTTP polling is used otherwise)')}:`,
    default: wssDefault || undefined,
    validate: (input) => {
      if (!input.trim()) return true // optional
      if (!input.startsWith('wss://') && !input.startsWith('ws://')) {
        return 'WebSocket URL must start with wss:// or ws:// (leave blank to skip)'
      }
      return true
    },
  }])

  if (isInfura && wss === wssDefault) {
    console.log(dim(`  ✓ Infura detected — auto-filled WSS endpoint.`))
  }

  return { wss: wss.trim(), http }
}

export async function collectRpcUrls(nodeType, network = 'testnet') {
  section('RPC Endpoints')

  const labels = chainLabels(network)
  tipBlock([
    `CAW uses Ethereum L1 and Base L2 on ${network === 'mainnet' ? 'mainnet' : 'testnet'}.`,
    'For each chain we need an HTTP (https://) RPC URL — that\'s what reads',
    'and submissions use. WebSocket (wss://) is optional and only enables',
    'real-time event subscription; with no WSS, the indexers fall back to',
    'HTTP polling (works fine for most operators).',
    '',
    'Free options: Infura, Alchemy, QuickNode (all have free tiers).',
    'For Infura URLs, the WSS endpoint is offered as a default so you can',
    'just press Enter. For other providers, leave WSS blank if you don\'t',
    'have a dedicated WSS URL — guessing produces unreachable endpoints.',
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

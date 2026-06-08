import inquirer from 'inquirer'
import { section, dim, tipBlock, warn, brand } from '../utils/ui.js'
import { chainLabels } from './networkAndMode.js'
import { withSecret, extractInfuraProjectId, infuraUrls } from '../utils/rpc.js'

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

// Conservative set of well-known free / shared RPCs. False positives here
// just produce a slightly-too-aggressive warning, which is the safer failure
// mode. Update this list as new public providers come online — the goal is
// surfacing risk, not keeping an exhaustive index.
const PUBLIC_RPC_HOSTS = [
  /\.publicnode\.com$/i,
  /^sepolia\.base\.org$/i,
  /^mainnet\.base\.org$/i,
  /^rpc\.sepolia\.org$/i,
  /^rpc\.ankr\.com$/i,
  /^cloudflare-eth\.com$/i,
  /^arbitrum-sepolia\.public\.blastapi\.io$/i,
  /^arb-sepolia\.public\.blastapi\.io$/i,
  /^endpoints\.omniatech\.io$/i,
  /^1rpc\.io$/i,
  /^rpc\.io$/i,
  /\.gateway\.tenderly\.co$/i,
]
function isPublicRpc(url) {
  try {
    const host = new URL(url).hostname
    return PUBLIC_RPC_HOSTS.some(re => re.test(host))
  } catch {
    return false
  }
}

// Hex → human-readable chain name. Used to flag RPCs that don't match the
// expected chain (e.g. operator pastes an Ethereum mainnet URL into the
// Arbitrum Sepolia prompt). Keep this list in sync with REPLICATION_CHAINS
// and STORAGE_CHAINS in clientCreator.js when new chains land.
const CHAIN_ID_NAMES = {
  1: 'Ethereum Mainnet',
  10: 'Optimism',
  137: 'Polygon',
  8453: 'Base',
  42161: 'Arbitrum One',
  // Testnets
  11155111: 'Ethereum Sepolia',
  84532: 'Base Sepolia',
  421614: 'Arbitrum Sepolia',
  11155420: 'Optimism Sepolia',
}

// Probe an RPC URL with eth_chainId. Returns the decimal chain ID, or null
// if the call fails (network error, malformed response, timeout, etc.).
// Caller treats null as "couldn't verify" — we don't punish the operator
// for an offline RPC during install, just for one we proved is wrong.
//
// `secret` is the optional Infura-style API Key Secret. We embed it as Basic
// Auth (withSecret) so the probe authenticates the same way the backend will.
// Without it, a project with "require API key secret" enabled 403s the probe
// and we'd warn "couldn't verify" on a URL that's actually fine — which is
// exactly what happens if you probe BEFORE collecting the secret.
async function probeChainId(url, timeoutMs = 4000, secret = '') {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(withSecret(url, secret), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: ctrl.signal,
    })
    clearTimeout(t)
    if (!res.ok) return null
    const data = await res.json()
    if (typeof data?.result !== 'string') return null
    return parseInt(data.result, 16)
  } catch {
    return null
  }
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
async function collectRpcPair(label, required, expectedChainId) {
  // Step 1: HTTP URL (required for the chain to function at all). Loops
  // until we get a URL that either matches `expectedChainId` (if provided)
  // or the operator confirms the mismatch is intentional. Without this
  // check, pasting e.g. an Ethereum mainnet URL into the Arbitrum Sepolia
  // prompt produces a working-looking install that explodes at first
  // contract read.
  // Collect HTTP URL + (for Infura) the API Key Secret, THEN probe with the
  // secret applied. Probing before collecting the secret 403s a
  // secret-required project and falsely reports "couldn't verify" on a good
  // URL. The secret is collected up front here and reused for the probe and
  // returned for the runtime.
  let http
  let secret = ''
  while (true) {
    const answer = await inquirer.prompt([{
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
    http = answer.http.trim()
    if (!http) break

    // API Key Secret opt-in (Infura). Asked before the probe so the probe
    // authenticates. Lets the operator lock the project's origin allowlist
    // to their site (frontend bundle safe) while backend traffic bypasses
    // it via Basic Auth. Non-Infura providers paste whatever serves the
    // same role; leave blank if unsure.
    secret = ''
    if (isInfuraUrl(http)) {
      const { hasSecret } = await inquirer.prompt([{
        type: 'confirm',
        name: 'hasSecret',
        message: `Use Infura's API Key Secret on the backend? ${dim('(lets you lock the project to your domains while backend traffic still works)')}`,
        default: false,
      }])
      if (hasSecret) {
        const { secretInput } = await inquirer.prompt([{
          type: 'password',
          name: 'secretInput',
          message: 'Infura API Key Secret:',
          mask: '*',
          validate: (input) => input.trim().length > 0 ? true : 'Cannot be empty (Ctrl+C to skip)',
        }])
        secret = secretInput.trim()
      }
    }

    if (!expectedChainId) break

    // Probe eth_chainId WITH the secret. If the RPC returns the wrong chain,
    // give the operator a chance to re-enter without crashing the install.
    const actual = await probeChainId(http, 4000, secret)
    if (actual === null) {
      // Couldn't verify — could be a transient network blip or an RPC that
      // needs auth we still don't have. Warn but accept.
      console.log(dim(`  (Couldn't verify chain ID via eth_chainId — RPC may be temporarily unreachable.)`))
      break
    }
    if (actual === expectedChainId) {
      console.log(dim(`  ✓ Chain ID ${actual} matches ${CHAIN_ID_NAMES[actual] || 'expected'}.`))
      break
    }
    const actualName = CHAIN_ID_NAMES[actual] || `chain ${actual}`
    const expectedName = CHAIN_ID_NAMES[expectedChainId] || `chain ${expectedChainId}`
    console.log()
    console.log(warn(`  Chain mismatch: that URL responded with ${brand(actualName)} (chainId ${actual}).`))
    console.log(warn(`  Expected ${brand(expectedName)} (chainId ${expectedChainId}) for this prompt.`))
    console.log()
    const { reenter } = await inquirer.prompt([{
      type: 'confirm',
      name: 'reenter',
      message: `Re-enter the ${expectedName} URL?`,
      default: true,
    }])
    if (!reenter) break
  }

  if (!http.trim()) return { wss: '', http: '' }

  // Public RPC sanity warning. We don't block the install — operators may
  // legitimately want a free endpoint for testing or low-volume nodes — but
  // we do want them to make an informed choice. The risks (rate limits,
  // outages, the RPC operator can lie about state) are real for a validator.
  if (isPublicRpc(http)) {
    console.log()
    console.log(warn(`  Heads up: ${new URL(http).hostname} looks like a free / shared public RPC.`))
    console.log(dim('    • Rate limits are aggressive and shared with every other user'))
    console.log(dim('    • Outages happen with no warning'))
    console.log(dim('    • The RPC operator sees every read + every tx you sign'))
    console.log(dim('    • A misbehaving public RPC can return stale state — bad for a validator'))
    console.log(dim('    Fine for trying things out; for a real node, use a paid provider.'))
    console.log(dim('    Recommended free tiers for CAW: Infura, dRPC (5 keys/account), QuickNode.'))
    console.log(dim('    AVOID Alchemy free tier — its 10-block eth_getLogs cap breaks the indexer.'))
    console.log()
  }

  // Step 2: WSS URL (optional). When the HTTP URL is Infura, offer the
  // auto-derived WSS as a default; otherwise leave blank — most providers
  // either give you a separate WSS URL or don't expose one at all.
  //
  // The hint text branches on whether we have a default: pre-filling with
  // a default while telling the operator to "leave blank to skip" reads
  // as a contradiction. With a default, just say "Enter to accept".
  const isInfura = isInfuraUrl(http)
  const wssDefault = isInfura ? inferWsFromHttp(http) : ''
  const wssHint = wssDefault
    ? '(optional — Enter to accept the auto-derived URL, or paste your own)'
    : '(optional — leave blank to skip; HTTP polling is used otherwise)'

  const { wss } = await inquirer.prompt([{
    type: 'input',
    name: 'wss',
    message: `${label} WebSocket RPC URL ${dim(wssHint)}:`,
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

  // (The API Key Secret was already collected above, before the chain-ID
  // probe, so the probe could authenticate. `secret` holds it here.)

  // NOTE (2026-06): we no longer ask for a separate frontend RPC URL.
  // The browser bundle talks to the backend's same-origin RPC proxy
  // (/api/rpc/l1, /api/rpc/l2 — see api/routes/rpc-proxy.ts), which keeps
  // the Infura key out of the bundle entirely and folds identical reads
  // across all connected browsers into ~1× upstream fan-out. generate.js
  // therefore does NOT write VITE_L*_RPC_URL by default; Web3Provider.tsx
  // falls through to the proxy. An operator who genuinely needs to bypass
  // the proxy (tests, or a static-hosted FE with no backend) can still set
  // VITE_L1_RPC_URL / VITE_L2_RPC_URL by hand — the FE honors them as an
  // override. We don't surface that as a prompt because for a normal node
  // install it's the wrong choice (leaks the key into the bundle and
  // bypasses the proxy's caching + origin gate).
  return { wss: wss.trim(), http, secret, frontendHttp: '' }
}

/**
 * L1 RPC + Ethereum Mainnet RPC (price feeds). Asked early in the install,
 * BEFORE the operator picks a client, because L1 is unambiguous (always
 * Ethereum) and the validator step + client lookup both need it.
 *
 * Returns: { l1RpcUrl, l1RpcUrlHttp, ethMainnetRpcUrl } — only the keys
 * relevant for the current nodeType. Validator/full nodes get all three;
 * api-only / frontend-api nodes get just the L1 pair (no price feeds
 * because they don't run a validator); frontend-only gets nothing.
 */
export async function collectL1Rpc(nodeType, network = 'testnet') {
  const needsL1 = ['full', 'validator', 'api-only', 'frontend-api'].includes(nodeType)
  if (!needsL1) return {}

  // Skip the prompt entirely if --env preloaded values for this step.
  // CAW_L1_RPC_URL_HTTP is the required one; WSS + ETH-mainnet are
  // optional (WSS) or only-validators (ETH-mainnet) so we mirror the
  // same conditional.
  if (process.env.CAW_L1_RPC_URL_HTTP) {
    section('L1 RPC')
    console.log(dim('  Using L1 RPC from --env preload (CAW_L1_RPC_URL_HTTP).'))
    const answers = {
      l1RpcUrl: process.env.CAW_L1_RPC_URL || '',
      l1RpcUrlHttp: process.env.CAW_L1_RPC_URL_HTTP,
      // Preserve HTTP-auth secrets (Infura, etc.) on re-runs. Dropping these
      // breaks RPC calls silently — providers respond with 401 to unauth'd
      // requests but our error path treats it as a generic network error.
      l1RpcSecret: process.env.CAW_L1_RPC_SECRET || '',
    }
    if (['full', 'validator'].includes(nodeType) && process.env.CAW_ETH_MAINNET_RPC_URL) {
      answers.ethMainnetRpcUrl = process.env.CAW_ETH_MAINNET_RPC_URL
      if (process.env.CAW_ETH_MAINNET_RPC_SECRET) {
        answers.ethMainnetRpcSecret = process.env.CAW_ETH_MAINNET_RPC_SECRET
      }
    } else if (['full', 'validator'].includes(nodeType)) {
      // Mainnet RPC wasn't preloaded — still need to ask.
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

  section('L1 RPC')

  // ── Infura fast path ──────────────────────────────────────────────────────
  // Operators using Infura answer ONE project-key prompt + ONE secret prompt
  // instead of three separate per-chain URL prompts (L1, L2, mainnet price
  // feed). All three URLs are derived from the same project ID.
  const { useInfura } = await inquirer.prompt([{
    type: 'confirm',
    name: 'useInfura',
    message: `Are you using ${brand('Infura')} for your RPC endpoints? ${dim('(recommended provider)')}`,
    default: true,
  }])

  if (useInfura) {
    // Step a: collect the Infura project key (full URL or bare 32-hex ID).
    let projectId = ''
    while (!projectId) {
      const { keyInput } = await inquirer.prompt([{
        type: 'input',
        name: 'keyInput',
        message: `Infura project key ${dim('(full URL or bare 32-hex project ID):')}`,
        validate: (input) => {
          if (!input.trim()) return 'Project key is required'
          const id = extractInfuraProjectId(input.trim())
          if (!id) return 'Could not extract a 32-hex project ID — paste the full URL or the bare ID from your Infura dashboard'
          return true
        },
      }])
      projectId = extractInfuraProjectId(keyInput.trim())
    }

    // Step b: optional API Key Secret (one secret reused for all chains).
    let infuraSecret = ''
    const { hasSecret } = await inquirer.prompt([{
      type: 'confirm',
      name: 'hasSecret',
      message: `Do you have an ${brand('API Key Secret')} for this project? ${dim('(lets you lock the project allowlist while backend traffic still authenticates)')}`,
      default: false,
    }])
    if (hasSecret) {
      const { secretInput } = await inquirer.prompt([{
        type: 'password',
        name: 'secretInput',
        message: 'Infura API Key Secret:',
        mask: '*',
        validate: (input) => input.trim().length > 0 ? true : 'Cannot be empty (Ctrl+C to skip)',
      }])
      infuraSecret = secretInput.trim()
    }

    // Step c: one-time allowlist note.
    const isMainnet = network === 'mainnet'
    const neededNetworks = isMainnet
      ? ['Ethereum Mainnet', 'Base', 'Arbitrum']
      : ['Ethereum Sepolia', 'Base Sepolia', 'Arbitrum Sepolia', 'Ethereum Mainnet (price feed — always real mainnet)']
    tipBlock([
      `Enable these networks on your Infura project (${brand(projectId)}):`,
      ...neededNetworks.map(n => `  • ${n}`),
      '',
      'Go to: dashboard.infura.io → your project → Networks.',
      '',
      'If you set an origin or IP allowlist on the project, the API Key Secret',
      'you just provided overrides it for this node\'s server-side calls — so',
      'backend RPC traffic works even with a locked-down project. The browser',
      'talks to this node\'s /api/rpc proxy and never sees the secret.',
    ])

    // Step d: derive L1 + mainnet price-feed URLs (correct by construction,
    // no probe needed).
    const l1Derived = infuraUrls(network, 'l1', projectId)
    const mainnetDerived = infuraUrls(network, 'ethMainnet', projectId)

    console.log(dim(`  Derived L1 RPC:     ${l1Derived.http}`))
    if (['full', 'validator'].includes(nodeType) && mainnetDerived) {
      console.log(dim(`  Derived mainnet RPC: ${mainnetDerived.http} ${dim('(price feeds)')}`))
    }
    console.log()

    // Step e: build answers.
    const answers = {
      l1RpcUrl: l1Derived.wss,
      l1RpcUrlHttp: l1Derived.http,
      l1RpcSecret: infuraSecret,
      l1RpcUrlHttpFrontend: '',
      // Stash for collectL2Rpc so it can derive the L2 URL without re-prompting.
      _infura: { projectId, secret: infuraSecret },
    }
    if (['full', 'validator'].includes(nodeType) && mainnetDerived) {
      answers.ethMainnetRpcUrl = mainnetDerived.http
      if (infuraSecret) answers.ethMainnetRpcSecret = infuraSecret
    }
    return answers
  }
  // ── End Infura fast path ──────────────────────────────────────────────────

  tipBlock([
    'CAW uses Ethereum L1 for the canonical username registry — every',
    'install reads from L1 to look up usernames, validate signatures, and',
    `(for ${brand('full')} / ${brand('validator')} nodes) submit identity transactions.`,
    '',
    'We need an HTTP (https://) URL — required, no fallback. WebSocket',
    '(wss://) is optional and only enables real-time event subscription;',
    'with no WSS, the indexers fall back to HTTP polling (works fine).',
    '',
    'Recommended free tiers for CAW: Infura, dRPC (5 keys/account), QuickNode.',
    'AVOID Alchemy free tier — its 10-block eth_getLogs cap silently breaks',
    'the indexer + validator. Multiple operators have hit this.',
    '',
    'For Infura URLs, the WSS endpoint is offered as a default so you can',
    'just press Enter.',
  ])

  const labels = chainLabels(network)
  const l1ExpectedChainId = network === 'mainnet' ? 1 : 11155111
  const l1 = await collectRpcPair(labels.l1, true, l1ExpectedChainId)

  const answers = {
    l1RpcUrl: l1.wss,
    l1RpcUrlHttp: l1.http,
    l1RpcSecret: l1.secret || '',
    // Optional separate URL for the browser bundle. Falls back to
    // l1RpcUrlHttp at write time when blank.
    l1RpcUrlHttpFrontend: l1.frontendHttp || '',
  }

  // Mainnet price feeds — only validators need this (CAW/ETH price for tip
  // accounting). Skip for non-validators. Use collectRpcPair's HTTP-only
  // path indirectly: we don't ask for a WSS pair for the price feed, so
  // do a one-off prompt with the same chainId guard inlined.
  if (['full', 'validator'].includes(nodeType)) {
    let ethMainnetRpcUrl = ''
    let ethMainnetRpcSecret = ''
    while (true) {
      const ans = await inquirer.prompt([{
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
      ethMainnetRpcUrl = ans.ethMainnetRpcUrl.trim()

      // Collect the Infura API Key Secret BEFORE the chain-ID probe — a
      // secret-required project 403s an unauthenticated probe, which would
      // make a perfectly good URL look "unverifiable". Same opt-in as the
      // L1/L2 collector; mainnet reads (Uniswap price feeds in
      // ChainSyncService / ValidatorService) are server-side, so the secret
      // unblocks them without weakening frontend protection.
      ethMainnetRpcSecret = ''
      if (isInfuraUrl(ethMainnetRpcUrl)) {
        const { hasSecret } = await inquirer.prompt([{
          type: 'confirm',
          name: 'hasSecret',
          message: `Use Infura's API Key Secret on the mainnet RPC? ${dim('(server-side only)')}`,
          default: false,
        }])
        if (hasSecret) {
          const { secretInput } = await inquirer.prompt([{
            type: 'password',
            name: 'secretInput',
            message: 'Mainnet Infura API Key Secret:',
            mask: '*',
            validate: (input) => input.trim().length > 0 ? true : 'Cannot be empty (Ctrl+C to skip)',
          }])
          ethMainnetRpcSecret = secretInput.trim()
        }
      }

      // Now probe WITH the secret applied.
      const actual = await probeChainId(ethMainnetRpcUrl, 4000, ethMainnetRpcSecret)
      if (actual === null || actual === 1) {
        if (actual === 1) console.log(dim(`  ✓ Chain ID 1 matches Ethereum Mainnet.`))
        else console.log(dim(`  (Couldn't verify chain ID via eth_chainId — RPC may be temporarily unreachable.)`))
        break
      }
      const actualName = CHAIN_ID_NAMES[actual] || `chain ${actual}`
      console.log()
      console.log(warn(`  Chain mismatch: that URL responded with ${brand(actualName)} (chainId ${actual}).`))
      console.log(warn(`  Expected ${brand('Ethereum Mainnet')} (chainId 1) — this is the price-feed RPC, must be mainnet.`))
      console.log()
      const { reenter } = await inquirer.prompt([{
        type: 'confirm',
        name: 'reenter',
        message: 'Re-enter the Ethereum Mainnet URL?',
        default: true,
      }])
      if (!reenter) break
    }
    answers.ethMainnetRpcUrl = ethMainnetRpcUrl
    if (ethMainnetRpcSecret) answers.ethMainnetRpcSecret = ethMainnetRpcSecret
  }

  return answers
}

// Map storage-chain labels (as set in clientCreator's STORAGE_CHAINS table)
// to their EVM chain IDs. Used by collectL2Rpc to verify the operator's
// pasted URL matches the chain their client actually stores on. Keep in
// sync with STORAGE_CHAINS in clientCreator.js.
const STORAGE_LABEL_TO_CHAIN_ID = {
  'Base Sepolia': 84532,
  'Arbitrum Sepolia': 421614,
  'Ethereum Sepolia (L1)': 11155111,
  'Base': 8453,
  'Arbitrum': 42161,
  'Ethereum Mainnet (L1)': 1,
}

/**
 * L2 RPC for the storage chain of the operator's chosen client. Asked AFTER
 * client selection so the prompt label can name the actual chain (Base
 * Sepolia / Arbitrum Sepolia / Ethereum Sepolia for L1-as-storage / etc.).
 *
 * `storageChainLabel` is the human-readable name (e.g. "Base Sepolia").
 * Falls back to a generic label if the caller doesn't know the chain.
 *
 * `network` ('testnet' | 'mainnet') is required when ctx.infura is set so
 * infuraUrls() can pick the right host. Thread from caw.js alongside ctx.
 *
 * `ctx` is optional context from the L1 step. When `ctx.infura.projectId`
 * is set (Infura fast path), the L2 URL is derived without prompting.
 *
 * Returns: { l2RpcUrl, l2RpcUrlHttp }. Empty {} for frontend-only callers
 * that don't need to submit / index L2 events.
 */
export async function collectL2Rpc(nodeType, storageChainLabel, network = 'testnet', ctx = {}) {
  if (nodeType === 'frontend-only') return {}

  // Skip the prompt if --env preloaded the L2 HTTP URL.
  if (process.env.CAW_L2_RPC_URL_HTTP) {
    section(`${storageChainLabel || 'L2'} RPC`)
    console.log(dim('  Using L2 RPC from --env preload (CAW_L2_RPC_URL_HTTP).'))
    return {
      l2RpcUrl: process.env.CAW_L2_RPC_URL || '',
      l2RpcUrlHttp: process.env.CAW_L2_RPC_URL_HTTP,
      // Preserve HTTP-auth secret on re-runs (see L1 collector for rationale).
      l2RpcSecret: process.env.CAW_L2_RPC_SECRET || '',
    }
  }

  // ── Infura fast path ──────────────────────────────────────────────────────
  // If collectL1Rpc used the Infura fast path, derive the L2 URL from the
  // same project ID without re-prompting. infuraUrls() uses the storage-chain
  // label directly as the role key (e.g. 'Base Sepolia', 'Arbitrum Sepolia').
  if (ctx.infura?.projectId) {
    const l2Derived = infuraUrls(network, storageChainLabel, ctx.infura.projectId)
    if (l2Derived) {
      section(`${storageChainLabel || 'L2'} RPC`)
      console.log(dim(`  Derived from Infura project (fast path): ${l2Derived.http}`))
      console.log()
      return {
        l2RpcUrl: l2Derived.wss,
        l2RpcUrlHttp: l2Derived.http,
        l2RpcSecret: ctx.infura.secret || '',
        l2RpcUrlHttpFrontend: '',
      }
    }
    // The storage chain isn't in INFURA_HOSTS (shouldn't happen for supported
    // chains, but fall through to the manual prompt rather than crashing).
    console.log(dim(`  (Infura fast path: no known host for "${storageChainLabel}" — falling back to manual prompt.)`))
  }
  // ── End Infura fast path ──────────────────────────────────────────────────

  section(`${storageChainLabel || 'L2'} RPC`)
  tipBlock([
    `Your client's storage chain is ${brand(storageChainLabel || 'an L2')}.`,
    'Every action your node submits or indexes flows through this chain,',
    'so a reliable RPC matters more here than for L1.',
    '',
    'Same rules as the L1 step: HTTP required, WSS optional. For free tiers,',
    'Infura / dRPC / QuickNode all support Base + Arbitrum. AVOID Alchemy',
    'free tier here too — same 10-block eth_getLogs cap problem.',
  ])

  const expectedChainId = STORAGE_LABEL_TO_CHAIN_ID[storageChainLabel] || null
  const l2 = await collectRpcPair(storageChainLabel || 'L2', true, expectedChainId)
  return {
    l2RpcUrl: l2.wss,
    l2RpcUrlHttp: l2.http,
    l2RpcSecret: l2.secret || '',
    l2RpcUrlHttpFrontend: l2.frontendHttp || '',
  }
}

/**
 * Backwards-compat wrapper used only when the caller doesn't yet know the
 * storage chain (e.g. legacy code paths or tests). Asks both RPCs in the
 * old order with generic labels. New code should call collectL1Rpc() and
 * collectL2Rpc() separately so the L2 prompt can name the chain.
 */
export async function collectRpcUrls(nodeType, network = 'testnet') {
  const l1 = await collectL1Rpc(nodeType, network)
  const labels = chainLabels(network)
  const l2 = await collectL2Rpc(nodeType, labels.l2, network, { infura: l1._infura })
  return { ...l1, ...l2 }
}

// Shared RPC-provider builder for the CLI. Every place the installer reads
// the chain (validator-username lookup, Network storage-chain lookup, Network
// creation, client/API discovery) MUST go through here so two things are
// always handled the same way:
//
//   1. The Infura-style API Key Secret. When a provider's project has
//      "require API key secret" enabled, a bare JsonRpcProvider(url) 403s
//      with "rejected due to project ID settings". We embed the secret as
//      Basic Auth (https://:SECRET@host/...), the same form the backend's
//      makeJsonRpcProvider uses.
//
//   2. staticNetwork. Without it, ethers background-polls eth_chainId and,
//      when the RPC rejects or is unreachable, spams "JsonRpcProvider failed
//      to detect network, retry in 1s" forever — including after the calling
//      code has already given up and moved on. staticNetwork disables that.
//
// History: the installer had FOUR bare provider sites, each independently
// missing the secret. They surfaced one at a time as different lookups hit a
// secret-required project. This helper exists so there's ONE correct builder.

// Infura subdomain per (network, chain-role). One project ID + secret works
// across all of these — you just swap the host. The CLI uses this to derive
// every RPC URL from a single Infura project, so the operator answers one key
// + one secret instead of three separate URL prompts.
//   testnet: L1=Ethereum Sepolia, storage L2 = Base or Arbitrum Sepolia,
//            price feed = Ethereum mainnet (always mainnet — price is real).
//   mainnet: L1=Ethereum mainnet, storage L2 = Base or Arbitrum, price = mainnet.
const INFURA_HOSTS = {
  testnet: {
    l1: 'sepolia.infura.io',
    'Base Sepolia': 'base-sepolia.infura.io',
    'Arbitrum Sepolia': 'arbitrum-sepolia.infura.io',
    'Ethereum Sepolia (L1)': 'sepolia.infura.io',
    ethMainnet: 'mainnet.infura.io',
  },
  mainnet: {
    l1: 'mainnet.infura.io',
    'Base': 'base-mainnet.infura.io',
    'Arbitrum': 'arbitrum-mainnet.infura.io',
    'Ethereum Mainnet (L1)': 'mainnet.infura.io',
    ethMainnet: 'mainnet.infura.io',
  },
}

/**
 * Pull the Infura project ID (the 32-hex /v3/<ID> segment) out of any Infura
 * URL — accepts either the full https URL or just the bare ID. Returns '' if
 * it doesn't look like an Infura project ID.
 */
export function extractInfuraProjectId(input) {
  if (!input) return ''
  const s = input.trim()
  // Bare 32-hex ID.
  if (/^[0-9a-fA-F]{32}$/.test(s)) return s.toLowerCase()
  // Full URL — grab the /v3/<id> or /ws/v3/<id> segment.
  const m = s.match(/\/v3\/([0-9a-fA-F]{32})/)
  return m ? m[1].toLowerCase() : ''
}

/**
 * Build the HTTPS + WSS Infura URLs for a (network, chainKeyOrRole, projectId).
 * `role` is either 'l1' / 'ethMainnet' or a storage-chain label like
 * 'Base Sepolia'. Returns { http, wss } or null when the role/network has no
 * known Infura host (operator falls back to a manual prompt for that chain).
 */
export function infuraUrls(network, role, projectId) {
  const host = (INFURA_HOSTS[network] || {})[role]
  if (!host || !projectId) return null
  return {
    http: `https://${host}/v3/${projectId}`,
    // Infura WSS endpoint: same host, /ws/v3/ path.
    wss: `wss://${host}/ws/v3/${projectId}`,
  }
}

/**
 * Embed an Infura-style API Key Secret as Basic Auth in the RPC URL.
 * `https://host/v3/KEY` + secret → `https://:SECRET@host/v3/KEY`. ethers'
 * JsonRpcProvider over HTTPS forwards the userinfo as a Basic Auth header.
 * No-op when the secret is empty or the URL already carries auth.
 */
export function withSecret(url, secret) {
  if (!url || !secret) return url
  try {
    const u = new URL(url)
    if (u.username || u.password) return url // operator already set auth
    u.password = secret
    return u.toString()
  } catch {
    return url
  }
}

/**
 * Build a JsonRpcProvider that authenticates with the optional secret and
 * does not background-poll for the network.
 *
 * @param {object} ethers   The imported ethers module (callers already
 *                          `await import('ethers')`, so we take it as a param
 *                          rather than re-importing).
 * @param {string} url      RPC URL.
 * @param {string} [secret] Optional API Key Secret (Basic Auth).
 * @returns {import('ethers').JsonRpcProvider}
 */
export function makeProvider(ethers, url, secret) {
  // Network.from(0) = "don't detect" — we never need the chainId for the
  // read-only lookups the installer does, and disabling detection is what
  // stops the retry-spam when the endpoint is unreachable / unauthorized.
  return new ethers.JsonRpcProvider(withSecret(url, secret), undefined, {
    staticNetwork: ethers.Network.from(0),
  })
}

/**
 * Run `fn(provider)` against a freshly-built provider and ALWAYS destroy it
 * afterward, so its keep-alive / retry timers don't outlive the call (the
 * other half of the "retry forever" bug — a leaked provider keeps polling).
 *
 * @param {object} ethers
 * @param {string} url
 * @param {string|undefined} secret
 * @param {(provider: import('ethers').JsonRpcProvider) => Promise<any>} fn
 */
export async function withProvider(ethers, url, secret, fn) {
  const provider = makeProvider(ethers, url, secret)
  try {
    return await fn(provider)
  } finally {
    try { provider.destroy?.() } catch { /* noop */ }
  }
}

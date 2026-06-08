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

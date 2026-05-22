/**
 * networkNameAlias.ts
 *
 * Display-name aliases for on-chain Network names. The Network name on
 * CawNetworkManager is set at registerNetwork() time and is NOT mutable —
 * once a Network is registered with a name, that name is permanent on
 * that contract deployment.
 *
 * The testnet's first Network is named "Uruk (testnet)" on-chain. We want
 * the same word "Uruk" available as the brand for the first mainnet
 * Network, so we display it on the FE/CLI as "Sepolia-Uruk" instead.
 * This is purely cosmetic; nothing in the contract or indexer cares.
 *
 * TODO[mainnet]: delete this file (and its callers in useNetworkFees +
 * the CLI installer) before mainnet deploy — the aliasing is a testnet-
 * only concern and would just create confusion once the live "Uruk"
 * Network exists on mainnet.
 */

const ALIASES: Record<string, string> = {
  'Uruk (testnet)': 'Sepolia-Uruk',
}

/**
 * Map an on-chain Network name to its display name. Returns the input
 * unchanged when there's no alias.
 */
export function displayNetworkName(name: string | null | undefined): string | null {
  if (name == null) return null
  return ALIASES[name] ?? name
}

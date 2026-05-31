/**
 * networkNameAlias.ts
 *
 * Display-name aliases for on-chain Network names. The Network name on
 * CawNetworkManager is set at registerNetwork() time and is NOT mutable —
 * once a Network is registered with a name, that name is permanent on
 * that contract deployment.
 *
 * Current deploys write the correct on-chain names already (see deploy.js
 * — mainnet gets "Uruk" / "Babylon", testnet gets "Sepolia-Uruk" /
 * "Sepolia-Babylon"), so the table here is a defense-in-depth shim that
 * also catches the older "Uruk (testnet)" string from the pre-2026-05-31
 * deploy. New deploys pass through unchanged.
 *
 * Safe to delete the legacy entries (the "(testnet)" suffixed ones) once
 * no live deployment carries those names on-chain.
 */

const ALIASES: Record<string, string> = {
  // Legacy pre-2026-05-31 testnet deploys — kept until those are retired.
  'Uruk (testnet)':    'Sepolia-Uruk',
  'Babylon (testnet)': 'Sepolia-Babylon',
}

/**
 * Map an on-chain Network name to its display name. Returns the input
 * unchanged when there's no alias.
 */
export function displayNetworkName(name: string | null | undefined): string | null {
  if (name == null) return null
  return ALIASES[name] ?? name
}

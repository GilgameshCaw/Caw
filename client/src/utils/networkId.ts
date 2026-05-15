/**
 * Resolves the operator-tier Network ID this process belongs to.
 * Reads NETWORK_ID first (new CLI installs since the client→network rename),
 * falls back to CLIENT_ID (existing installs with the older env var).
 * Returns null if neither is set (caller decides whether that's fatal).
 */
export function getNetworkId(): string | null {
  return process.env.NETWORK_ID ?? process.env.CLIENT_ID ?? null
}

export function requireNetworkId(): string {
  const id = getNetworkId()
  if (!id) {
    throw new Error('NETWORK_ID (or legacy CLIENT_ID) is required but not set')
  }
  return id
}

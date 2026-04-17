/**
 * Extract a user-friendly message from an error thrown by wagmi/viem/wallet
 * libraries. Viem errors come with "Details:" and "Version: viem@x.y.z"
 * trailers that users don't need to see — strip them.
 *
 * Examples:
 *   "User rejected the request. Details: User rejected the request. Version: viem@2.31.3"
 *     → "User rejected the request"
 */
export function formatWalletError(err: unknown): string {
  if (!err) return 'Something went wrong'
  const raw = err instanceof Error ? err.message : String(err)

  // Normalize common user-rejection variants to a single clean string.
  if (/user\s*(rejected|denied|cancelled)/i.test(raw)) {
    return 'User rejected the request'
  }

  // Strip viem's "Details:" and "Version:" trailers from the first line.
  return raw
    .split('\n')[0]
    .replace(/\s*Details:\s*.*$/i, '')
    .replace(/\s*Version:\s*viem@[\w.-]+\s*$/i, '')
    .trim()
}

/**
 * Returns the default avatar URL for a given ID (1-100).
 */
export function getDefaultAvatarUrl(id: number): string {
  const clamped = Math.max(1, Math.min(100, id || 1))
  return `/images/avatars/${clamped}.png`
}

/**
 * Returns the user's avatar URL: custom avatarUrl if set, otherwise the
 * default avatar based on defaultAvatarId. Falls back to a deterministic
 * default based on tokenId if neither is set (legacy users).
 */
export function getUserAvatar(user?: {
  avatarUrl?: string | null
  image?: string | null
  defaultAvatarId?: number | null
  tokenId?: number
} | null): string {
  if (user?.avatarUrl) return user.avatarUrl
  if (user?.image) return user.image
  if (user?.defaultAvatarId) return getDefaultAvatarUrl(user.defaultAvatarId)
  // Legacy fallback: deterministic from tokenId
  const id = user?.tokenId ? (user.tokenId % 100) + 1 : 1
  return getDefaultAvatarUrl(id)
}

/**
 * Returns true if the user is using a default avatar (no custom upload).
 */
export function isDefaultAvatar(user?: { avatarUrl?: string | null } | null): boolean {
  return !user?.avatarUrl
}

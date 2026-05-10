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

/**
 * Returns the user's deterministic default avatar URL, ignoring any
 * custom avatarUrl/image. Use as `fallbackSrc` on <Avatar> so a broken
 * custom upload falls through to the per-user default picture instead
 * of the generic silhouette. Same resolution order as getUserAvatar
 * minus the custom-URL branches.
 */
export function getDefaultAvatarForUser(user?: {
  defaultAvatarId?: number | null
  tokenId?: number
} | null): string {
  if (user?.defaultAvatarId) return getDefaultAvatarUrl(user.defaultAvatarId)
  const id = user?.tokenId ? (user.tokenId % 100) + 1 : 1
  return getDefaultAvatarUrl(id)
}

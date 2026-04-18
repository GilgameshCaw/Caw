/**
 * Returns a deterministic default avatar URL for a user based on their tokenId.
 * Uses tokenId % 100 + 1 so the same user always gets the same avatar,
 * and refreshes/re-renders don't flicker between different ones.
 */
export function getDefaultAvatar(tokenId?: number): string {
  const id = tokenId ? (tokenId % 100) + 1 : 1
  return `/images/avatars/${id}.png`
}

/**
 * Returns the user's avatar URL, falling back to a deterministic default.
 */
export function getUserAvatar(user?: { avatarUrl?: string | null; image?: string | null; tokenId?: number } | null): string {
  if (user?.avatarUrl) return user.avatarUrl
  if (user?.image) return user.image
  return getDefaultAvatar(user?.tokenId)
}

// Image variant URL derivation. Mirrors the server-side naming convention
// from /api/upload/variant: `<id>.webp` → `<id>_<width>.webp`.
//
// Why this is a pure string transform (no DB lookup): the variant naming
// is deterministic, every renderer can resolve the URL synchronously, and
// the <img onError> path naturally falls back to the original if the
// variant doesn't exist (e.g. for images uploaded before the variant
// system shipped, until the backfill runs).

/** 64px thumb variant of an avatar — used in feeds, comments, lists. */
export function avatarThumbUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  return appendWidthSuffix(url, 64)
}

/** 2048px large variant of a feed image — used in lightbox / click-to-expand. */
export function feedImageLargeUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  return appendWidthSuffix(url, 2048)
}

function appendWidthSuffix(url: string, width: number): string {
  // Don't try to derive variants for non-served URLs (data:, blob:, etc.)
  if (!url.startsWith('http') && !url.startsWith('/')) return url
  // Default avatars are static FE-bundled PNGs (/images/avatars/1.png …)
  // that have no thumb variants. Skipping here avoids a guaranteed 404 +
  // onError-fallback round-trip on every default-avatar render.
  if (url.includes('/images/avatars/')) return url
  // Only user-uploaded files in /uploads/images/ have variants. Anything
  // else is either external (S3, IPFS, gravatar) or a static asset.
  if (!url.includes('/uploads/images/')) return url
  const dot = url.lastIndexOf('.')
  if (dot < 0) return url
  const stem = url.slice(0, dot)
  // Already a variant? Don't double-suffix.
  if (/_\d+$/.test(stem)) return url
  // Variants are ALWAYS .webp regardless of source extension —
  // compressImage forces image/webp output, and the backfill script
  // also writes _N.webp. Using the original extension here would 404
  // for any source that wasn't already WebP (most JPGs/PNGs).
  return `${stem}_${width}.webp`
}

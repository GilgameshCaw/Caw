// Image variant URL derivation. Mirrors the server-side naming convention
// from /api/upload/variant, which preserves the base file's extension:
// `<id>.jpg` → `<id>_<width>.jpg`, `<id>.webp` → `<id>_<width>.webp`.
//
// Why this is a pure string transform (no DB lookup): the variant naming
// is deterministic, every renderer can resolve the URL synchronously, and
// the <img onError> path naturally falls back to the original if the
// variant doesn't exist (e.g. for images uploaded before the variant
// system shipped).

/** 96px square thumb variant of an avatar — used in feeds, comments,
 *  lists, profile chooser. Pre-variant uploads (no thumb generated)
 *  will 404 here and Avatar's onError falls back to the main URL. */
export function avatarThumbUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  return appendWidthSuffix(url, 96)
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
  const ext = url.slice(dot)
  // Already a variant? Don't double-suffix.
  if (/_\d+$/.test(stem)) return url
  // Preserve the base extension: the server-side variant route writes
  // `${stem}_${width}${ext}` regardless of the thumb's actual mime, so
  // `<id>.jpg` has its thumb at `<id>_96.jpg`, NOT `_96.webp`. Forcing
  // .webp here 404s on every jpg/png/gif avatar.
  return `${stem}_${width}${ext}`
}

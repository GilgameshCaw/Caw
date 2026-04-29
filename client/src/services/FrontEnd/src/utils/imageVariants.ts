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
  // or for URLs that already have a width suffix.
  if (!url.startsWith('http') && !url.startsWith('/')) return url
  const dot = url.lastIndexOf('.')
  if (dot < 0) return url
  const stem = url.slice(0, dot)
  const ext = url.slice(dot)
  // Already a variant? Don't double-suffix.
  if (/_\d+$/.test(stem)) return url
  return `${stem}_${width}${ext}`
}

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

/** 320px inline variant of a feed image — multi-image grids, mobile.
 *  Returns undefined for non-/uploads/images/ URLs (matching
 *  feedImageLargeUrl's behavior). */
export function feedImageSmallUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  return appendWidthSuffix(url, 320)
}

/** 640px inline variant of a feed image — single-image desktop / mobile
 *  retina. Returns undefined for non-/uploads/images/ URLs. */
export function feedImageMediumUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  return appendWidthSuffix(url, 640)
}

/** 2048px large variant of a feed image — used in lightbox / click-to-expand. */
export function feedImageLargeUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  return appendWidthSuffix(url, 2048)
}

/** Build an <img srcset> string offering 320 / 640 / 1024 widths from a
 *  feed image's main URL. Returns undefined if the URL isn't an
 *  /uploads/images/ asset (external avatars, IPFS, data URIs — for
 *  those just render the original src directly).
 *
 *  The browser uses srcset + sizes to pick the smallest variant that
 *  satisfies the CSS slot at the device's DPR. Always include all three
 *  candidates: the bandwidth saving from picking 320 over 1024 in a
 *  mobile two-up grid (~10× smaller payload) dwarfs the cost of the
 *  occasional missed-cache 640 on a single-image desktop view. */
export function feedImageSrcset(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  const small = feedImageSmallUrl(url)
  const medium = feedImageMediumUrl(url)
  // appendWidthSuffix returns the input unchanged for non-uploads URLs;
  // detecting that here lets callers fall back to a plain <img src>
  // instead of emitting a srcset that would 404 every candidate.
  if (small === url || medium === url) return undefined
  return `${small} 320w, ${medium} 640w, ${url} 1024w`
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

import imageCompression from 'browser-image-compression'

// Compression presets per upload context. Sized at 2× the largest place
// the asset is displayed, so retina screens get a 1:1 pixel mapping and
// non-retina screens get a single bilinear downscale. All targets are
// MAX values — smaller inputs pass through near-unchanged.
//
// Display sizes that drive these numbers:
//   - avatar small (thumb): ~35px in feeds/comments/lists → 64
//   - avatar large: 150px on profile page → 300
//   - cover photo: 570×180 on profile → 1140 wide
//   - feed image inline: ~600px wide on desktop → 1024 (display)
//   - feed image lightbox: full viewport → 2048 (cap; "giant" is wasted)
//   - quality 0.8: artifact threshold for photographs.
//   - WebP throughout: ~30% smaller than JPEG at the same visual quality.
const PRESETS = {
  /** Tiny avatar variant for feed/comments/lists (display ~35px). */
  thumb:        { maxSizeMB: 0.05, maxWidthOrHeight: 64,   quality: 0.85 },
  /** Avatar at profile-page size (display 150px, 2× retina). */
  avatar:       { maxSizeMB: 0.2,  maxWidthOrHeight: 300,  quality: 0.85 },
  /** Profile cover photo (display 570×180, 2× retina). */
  cover:        { maxSizeMB: 0.5,  maxWidthOrHeight: 1140, quality: 0.8 },
  /** Inline feed image — what the post body shows. */
  feed:         { maxSizeMB: 1,    maxWidthOrHeight: 1024, quality: 0.8 },
  /** Lightbox/click-to-expand version of a feed image. */
  feedLarge:    { maxSizeMB: 2,    maxWidthOrHeight: 2048, quality: 0.8 },
  /** Bug-report screenshots, moderator evidence — small but readable. */
  report:       { maxSizeMB: 0.5,  maxWidthOrHeight: 1280, quality: 0.75 },
  /** DM attachments — encrypted, so we can't recompress server-side. */
  dm:           { maxSizeMB: 0.75, maxWidthOrHeight: 1024, quality: 0.8 },
} as const

export type CompressionPreset = keyof typeof PRESETS

/**
 * Compress an image client-side before upload. Re-encodes to WebP at
 * the configured quality, caps max dimension, strips EXIF as a side
 * effect of the canvas re-render. Falls back to the original file on
 * any failure (better to upload a too-large image than to fail the
 * post entirely).
 *
 * Pass-through for non-image files — the caller is responsible for
 * its own video / encrypted-blob limits.
 */
export async function compressImage(file: File, preset: CompressionPreset = 'feed'): Promise<File> {
  // Non-images skip compression entirely. Caller (e.g. PostForm) decides
  // its own video limits up the stack.
  if (!file.type.startsWith('image/')) return file

  // GIFs would lose animation through canvas re-encode. Pass through
  // and let the server enforce a size cap. Animated WebP encoding from
  // a canvas isn't a thing in any browser yet.
  if (file.type === 'image/gif') return file

  const options = {
    ...PRESETS[preset],
    useWebWorker: true, // off-main-thread so the UI stays responsive
    fileType: 'image/webp' as const,
    // The library's "initial" size check — bail out of compression if
    // the input is already smaller than the target. Saves CPU on
    // already-small inputs.
    alwaysKeepResolution: false,
  }

  try {
    const compressed = await imageCompression(file, options)
    // Sanity check: if compression somehow produced a LARGER file (rare,
    // happens with already-optimized small JPEGs), use the original.
    if (compressed.size >= file.size) return file
    console.log(
      `[compressImage] ${preset}: ${(file.size / 1024).toFixed(0)}KB → ` +
      `${(compressed.size / 1024).toFixed(0)}KB (${Math.round((1 - compressed.size / file.size) * 100)}% smaller)`,
    )
    return compressed
  } catch (err) {
    // Don't break the upload flow on compression failure — pass through
    // the original. The server's size cap is the safety net.
    console.warn(`[compressImage] failed, falling back to original:`, err)
    return file
  }
}

/**
 * Convenience: compress all image files in an array, leave non-images alone.
 * Used by PostForm where the user can attach a mix of images + videos.
 */
export async function compressImages(files: File[], preset: CompressionPreset = 'feed'): Promise<File[]> {
  return Promise.all(files.map(f => compressImage(f, preset)))
}

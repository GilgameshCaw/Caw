import imageCompression from 'browser-image-compression'

// Compression presets per upload context. Sized at 2× the largest place
// the asset is displayed, so retina screens get a 1:1 pixel mapping and
// non-retina screens get a single bilinear downscale. All targets are
// MAX values — smaller inputs pass through near-unchanged.
//
// Display sizes that drive these numbers:
//   - avatar small (thumb): up to 48px in feeds/lists/profile chooser → 96 (2× retina)
//   - avatar large: 150px on profile page → 300
//   - cover photo: 570×180 on profile → 1140 wide
//   - feed image inline: ~600px wide on desktop → 1024 (display)
//   - feed image lightbox: full viewport → 2048 (cap; "giant" is wasted)
//   - quality 0.8: artifact threshold for photographs.
//   - WebP throughout: ~30% smaller than JPEG at the same visual quality.
const PRESETS = {
  /** Square avatar variant for feed/comments/lists/profile chooser
   *  (display up to 48px → 96 covers 2× retina). Callers should pass a
   *  pre-cropped square via cropToSquare() so the output is 96×96. */
  thumb:        { maxSizeMB: 0.05, maxWidthOrHeight: 96,   quality: 0.85 },
  /** Avatar at profile-page size (display 150px, 2× retina). */
  avatar:       { maxSizeMB: 0.2,  maxWidthOrHeight: 300,  quality: 0.85 },
  /** Profile cover photo (display 570×180, 2× retina). */
  cover:        { maxSizeMB: 0.5,  maxWidthOrHeight: 1140, quality: 0.8 },
  /** Inline feed image — what the post body shows. The render layer
   *  picks between feedSmall/feedMedium/feed via <img srcset>, so this
   *  is the upper bound for inline display (used by 1× desktop in a
   *  full-width slot). */
  feed:         { maxSizeMB: 1,    maxWidthOrHeight: 1024, quality: 0.8 },
  /** Inline feed image, mobile / multi-image-grid sizes. Slots range
   *  from ~180px (mobile two-up) to ~245px (desktop two-up); 320 covers
   *  2× retina on the mobile end. */
  feedSmall:    { maxSizeMB: 0.15, maxWidthOrHeight: 320,  quality: 0.8 },
  /** Inline feed image, desktop single-image / mobile single-image at
   *  2× retina. ~600px CSS slot × 2× DPR ≈ 1200px source pixels, but
   *  640 with quality 0.8 still looks sharp at that target — the
   *  bandwidth saving (~50% vs the 1024 main) outweighs the half-step
   *  upscale at the highest-density viewports. */
  feedMedium:   { maxSizeMB: 0.4,  maxWidthOrHeight: 640,  quality: 0.8 },
  /** Lightbox/click-to-expand version of a feed image. */
  feedLarge:    { maxSizeMB: 2,    maxWidthOrHeight: 2048, quality: 0.8 },
  /** Bug-report screenshots, moderator evidence — small but readable. */
  report:       { maxSizeMB: 0.5,  maxWidthOrHeight: 1280, quality: 0.75 },
  /** DM attachments — encrypted, so we can't recompress server-side. */
  dm:           { maxSizeMB: 0.75, maxWidthOrHeight: 1024, quality: 0.8 },
  /** Poll option image — display ~64px square (2× retina). Tighter byte
   *  cap than `thumb` because polls can have up to 6 of these per post,
   *  and we want the total payload for one poll's images to stay under
   *  ~100KB. */
  pollOption:   { maxSizeMB: 0.025, maxWidthOrHeight: 128, quality: 0.8 },
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

/**
 * Center-crop an image File to a square. The output is the largest square
 * that fits inside the source. Used to enforce 1:1 aspect on avatars
 * before they hit the compressor — otherwise a 64×139 portrait stays
 * portrait through the pipeline and only gets `object-cover`-cropped at
 * render time, wasting bytes and producing the wrong intrinsic shape.
 *
 * Pass-through for non-images and GIFs (canvas decode would lose
 * animation; the cropper is for static avatar uploads only).
 */
export async function cropToSquare(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file
  if (file.type === 'image/gif') return file

  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = reject
      el.src = url
    })
    const size = Math.min(img.naturalWidth, img.naturalHeight)
    if (size === img.naturalWidth && size === img.naturalHeight) return file
    const sx = Math.round((img.naturalWidth - size) / 2)
    const sy = Math.round((img.naturalHeight - size) / 2)
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(img, sx, sy, size, size, 0, 0, size, size)
    const blob: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), file.type, 0.95),
    )
    return new File([blob], file.name, { type: file.type, lastModified: Date.now() })
  } catch {
    return file
  } finally {
    URL.revokeObjectURL(url)
  }
}

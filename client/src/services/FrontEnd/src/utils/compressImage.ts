import imageCompression from 'browser-image-compression'

// Compression presets per upload context. Tuned to "looks fine to a human
// at the displayed size + leaves the server's 5MB image cap with plenty of
// headroom for almost any input." All targets are MAX values — smaller
// inputs pass through near-unchanged, sometimes even smaller after
// the re-encode.
//
// Why these specific numbers:
//   - 1024px max: covers retina viewing of a feed image (the rendered
//     element is ~600px wide on desktop, half that on mobile). 1024 is
//     2x the largest realistic display dimension.
//   - 256px avatar: the largest place an avatar renders is ~100px on
//     a profile header. 256 is again 2x.
//   - quality 0.8: the threshold below which compression artifacts
//     start to be visible on photographs. Above this is wasted bytes.
//   - WebP first, JPEG fallback: WebP is ~30% smaller than JPEG at the
//     same visual quality. Every browser that survives the
//     browser-image-compression check supports it. JPEG fallback is
//     belt-and-suspenders.
const PRESETS = {
  /** Post images, profile cover photos. */
  feed:    { maxSizeMB: 1, maxWidthOrHeight: 1024, quality: 0.8 },
  /** User avatars / profile pictures. */
  avatar:  { maxSizeMB: 0.5, maxWidthOrHeight: 256, quality: 0.85 },
  /** Bug-report screenshots, moderator evidence — small but readable. */
  report:  { maxSizeMB: 0.5, maxWidthOrHeight: 1280, quality: 0.75 },
  /** DM attachments — encrypted, so we can't recompress server-side.
   *  Keep them tighter so encrypted blobs stay manageable. */
  dm:      { maxSizeMB: 0.75, maxWidthOrHeight: 1024, quality: 0.8 },
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

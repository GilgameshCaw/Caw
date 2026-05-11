import { apiFetch, getAuthHeaders } from './client'
import { compressImage, compressImages, cropToSquare, type CompressionPreset } from '~/utils/compressImage'
import { compressVideo } from '~/utils/compressVideo'

export interface UploadImageResponse {
  success: boolean
  url?: string
  urls?: string[]
  error?: string
}

// Mirror the route caps in client/src/api/routes/upload.ts. Keeping these
// in sync with the server is a manual job — if the server caps change,
// update both places. Pre-upload validation here gives the user an
// immediate friendly error instead of waiting through the upload only to
// see a 413 from the server.
export const POST_IMAGE_MAX_BYTES = 1 * 1024 * 1024
export const POST_VIDEO_MAX_BYTES = 10 * 1024 * 1024

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/**
 * Upload one or more files (images or videos) via multipart /api/upload.
 * Image files are compressed client-side per the chosen preset before upload.
 * Videos pass through unchanged. Non-image files are rejected by the server's
 * MIME allowlist.
 *
 * Centralized so the compress→FormData→fetch dance lives in exactly one
 * place. Also dodges a class of 500s from iPhone HEIC uploads — the canvas
 * re-encode in compressImage() turns HEIC into WebP, which the server allows.
 */
export async function uploadMedia(
  files: File[],
  tokenId: number,
  preset: CompressionPreset = 'feed',
  onProgress?: (msg: string) => void,
): Promise<string[]> {
  if (files.length === 0) return []

  // Transcode oversized videos client-side before giving up. compressVideo
  // is a no-op for inputs already under the cap and for non-videos.
  const transcoded: File[] = []
  for (const f of files) {
    if (f.type.startsWith('video/') && f.size > POST_VIDEO_MAX_BYTES) {
      onProgress?.('Compressing video…')
      try {
        const result = await compressVideo(f, 'feed')
        if (result.file.size > POST_VIDEO_MAX_BYTES) {
          throw new Error(`Video still too large after compression (${fmtMB(result.file.size)}, max ${fmtMB(POST_VIDEO_MAX_BYTES)}). Try a shorter clip.`)
        }
        transcoded.push(result.file)
      } catch (err) {
        if (err instanceof Error) throw err
        throw new Error('Video compression failed. Try a shorter clip.')
      }
    } else {
      transcoded.push(f)
    }
  }

  const compressed = await compressImages(transcoded, preset)

  // Post-compression image size check. The compressor targets ~1MB but
  // can occasionally produce larger files (e.g. high-entropy screenshots
  // that don't shrink well). 2MB matches the server cap.
  const oversizedImage = compressed.find(f =>
    f.type.startsWith('image/') && f.size > POST_IMAGE_MAX_BYTES
  )
  if (oversizedImage) {
    throw new Error(`Image too large after compression (${fmtMB(oversizedImage.size)}, max ${fmtMB(POST_IMAGE_MAX_BYTES)}). Try a smaller source image.`)
  }

  const formData = new FormData()
  compressed.forEach(file => formData.append('media', file))
  formData.append('tokenId', String(tokenId))

  // Flip the progress indicator from "Compressing…" (or whatever the
  // previous stage was) to a generic upload state for the network leg.
  // PostForm reads this to keep the submit button honest while the
  // multipart body streams to the server.
  onProgress?.('Uploading…')
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: formData,
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Upload failed' }))
    throw new Error(err.error || `Upload failed (${res.status})`)
  }

  const data = await res.json()
  return data.urls || []
}

/**
 * Upload an avatar with a 96px square thumb variant alongside the 300px
 * square main file. Both are center-cropped to 1:1 before compression so
 * the stored intrinsic shape matches the always-square render.
 *
 * Returns just the main URL — the thumb URL is derived by callers via
 * `avatarThumbUrl(mainUrl)` (string substitution, see ~/utils/imageVariants).
 * If the thumb upload fails the main upload still succeeds; the renderer
 * falls back to the main file when the thumb 404s.
 */
export async function uploadAvatar(file: File, tokenId: number): Promise<string> {
  const square = await cropToSquare(file)
  const main = await compressImage(square, 'avatar')

  const formData = new FormData()
  formData.append('media', main)
  formData.append('tokenId', String(tokenId))
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: formData,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Upload failed' }))
    throw new Error(err.error || `Upload failed (${res.status})`)
  }
  const { urls } = await res.json()
  const mainUrl: string = urls?.[0]
  if (!mainUrl) throw new Error('No URL returned')

  // Fire-and-(mostly-)forget the thumb. We DO await so that the sequence is
  // predictable in tests, but we swallow errors — a missing thumb just means
  // the renderer falls back to the main file.
  try {
    const thumb = await compressImage(square, 'thumb')
    const baseFilename = mainUrl.split('/').pop()!
    const tFd = new FormData()
    tFd.append('media', thumb)
    tFd.append('baseFilename', baseFilename)
    tFd.append('width', '96')
    tFd.append('tokenId', String(tokenId))
    await fetch('/api/upload/variant', { method: 'POST', headers: getAuthHeaders(), body: tFd })
  } catch (err) {
    console.warn('[uploadAvatar] thumb generation failed, will fall back to main:', err)
  }

  return mainUrl
}

/**
 * Upload a feed image with a full set of inline + lightbox variants:
 *   - 1024 (main): hard upper bound for inline render at 1× desktop full-width.
 *   - 320, 640: srcset candidates the browser picks between based on slot
 *     size + DPR. Mobile two-up grids land on 320, single-image desktop on
 *     640 — both ~5–10× smaller than the 1024 they replace at those slots.
 *   - 2048: lightbox/click-to-expand only.
 *
 * Variants are uploaded sequentially so an early failure (auth, quota,
 * network) doesn't pile follow-ups on top. Each variant is best-effort —
 * a missing inline variant just means the renderer drops to the next-up
 * size; a missing lightbox means click-to-expand serves the 1024 main.
 */
export async function uploadFeedImage(file: File, tokenId: number): Promise<string> {
  const main = await compressImage(file, 'feed')
  const formData = new FormData()
  formData.append('media', main)
  formData.append('tokenId', String(tokenId))
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: formData,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Upload failed' }))
    throw new Error(err.error || `Upload failed (${res.status})`)
  }
  const { urls } = await res.json()
  const mainUrl: string = urls?.[0]
  if (!mainUrl) throw new Error('No URL returned')

  const baseFilename = mainUrl.split('/').pop()!
  const uploadVariant = async (preset: CompressionPreset, width: number) => {
    try {
      const variant = await compressImage(file, preset)
      const fd = new FormData()
      fd.append('media', variant)
      fd.append('baseFilename', baseFilename)
      fd.append('width', String(width))
      fd.append('tokenId', String(tokenId))
      await fetch('/api/upload/variant', { method: 'POST', headers: getAuthHeaders(), body: fd })
    } catch (err) {
      console.warn(`[uploadFeedImage] ${preset} variant failed, will fall back at render time:`, err)
    }
  }

  await uploadVariant('feedSmall', 320)
  await uploadVariant('feedMedium', 640)
  await uploadVariant('feedLarge', 2048)

  return mainUrl
}

/**
 * Upload a single image to the server
 */
export async function uploadImage(
  image: string,
  tokenId: number
): Promise<UploadImageResponse> {
  return apiFetch('/api/upload/image', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ image, tokenId })
  })
}

/**
 * Upload multiple images to the server
 */
export async function uploadImages(
  images: string[],
  tokenId: number
): Promise<UploadImageResponse> {
  return apiFetch('/api/upload/images', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ images, tokenId })
  })
}
import { apiFetch, getAuthHeaders } from './client'
import { compressImage, compressImages, type CompressionPreset } from '~/utils/compressImage'

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
): Promise<string[]> {
  if (files.length === 0) return []

  // Pre-flight video size check BEFORE compression so the user sees a
  // friendly error immediately instead of waiting through a doomed
  // upload. (Compression doesn't apply to videos anyway.)
  const oversizedVideo = files.find(f =>
    f.type.startsWith('video/') && f.size > POST_VIDEO_MAX_BYTES
  )
  if (oversizedVideo) {
    throw new Error(`Video too large (${fmtMB(oversizedVideo.size)}, max ${fmtMB(POST_VIDEO_MAX_BYTES)}). Trim the clip in another app first.`)
  }

  const compressed = await compressImages(files, preset)

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
 * Upload an avatar with a 64px thumb variant alongside the 300px main file.
 *
 * Returns just the main URL — the thumb URL is derived by callers via
 * `thumbUrl(mainUrl)` (string substitution, see ~/utils/imageVariants).
 * If the thumb upload fails the main upload still succeeds; the renderer
 * falls back to the main file when the thumb 404s.
 */
export async function uploadAvatar(file: File, tokenId: number): Promise<string> {
  const main = await compressImage(file, 'avatar')

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
    const thumb = await compressImage(file, 'thumb')
    const baseFilename = mainUrl.split('/').pop()!
    const tFd = new FormData()
    tFd.append('media', thumb)
    tFd.append('baseFilename', baseFilename)
    tFd.append('width', '64')
    tFd.append('tokenId', String(tokenId))
    await fetch('/api/upload/variant', { method: 'POST', headers: getAuthHeaders(), body: tFd })
  } catch (err) {
    console.warn('[uploadAvatar] thumb generation failed, will fall back to main:', err)
  }

  return mainUrl
}

/**
 * Upload a feed image with a 2048px lightbox variant alongside the 1024px
 * inline file. Same fall-back behavior as uploadAvatar.
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

  try {
    const large = await compressImage(file, 'feedLarge')
    const baseFilename = mainUrl.split('/').pop()!
    const tFd = new FormData()
    tFd.append('media', large)
    tFd.append('baseFilename', baseFilename)
    tFd.append('width', '2048')
    tFd.append('tokenId', String(tokenId))
    await fetch('/api/upload/variant', { method: 'POST', headers: getAuthHeaders(), body: tFd })
  } catch (err) {
    console.warn('[uploadFeedImage] lightbox variant failed, will fall back to main:', err)
  }

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
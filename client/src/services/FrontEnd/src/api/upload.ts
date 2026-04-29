import { apiFetch, getAuthHeaders } from './client'
import { compressImages, type CompressionPreset } from '~/utils/compressImage'

export interface UploadImageResponse {
  success: boolean
  url?: string
  urls?: string[]
  error?: string
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

  const compressed = await compressImages(files, preset)

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
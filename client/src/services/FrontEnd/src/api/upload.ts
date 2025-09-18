import { apiFetch } from './client'

export interface UploadImageResponse {
  success: boolean
  url?: string
  urls?: string[]
  error?: string
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
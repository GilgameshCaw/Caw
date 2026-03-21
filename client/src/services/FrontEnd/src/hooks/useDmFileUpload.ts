import { useState, useCallback } from 'react'
import { encryptBinary } from '~/services/DmCryptoService'
import { getAuthHeaders } from '~/api/client'

const MAX_IMAGE_DIMENSION = 1600
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB after compression

/**
 * Compress an image file if it exceeds dimension/size limits.
 * Returns the compressed file as a Uint8Array + its mime type.
 */
async function compressImage(file: File): Promise<{ data: Uint8Array; mimeType: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      let { width, height } = img

      // Scale down if needed
      if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
        const scale = MAX_IMAGE_DIMENSION / Math.max(width, height)
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, width, height)

      // Use webp if supported, fall back to jpeg
      const mimeType = 'image/webp'
      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error('Failed to compress image'))
          blob.arrayBuffer().then(buf => {
            resolve({ data: new Uint8Array(buf), mimeType, width, height })
          })
        },
        mimeType,
        0.85
      )
    }
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = URL.createObjectURL(file)
  })
}

/**
 * Read a file as Uint8Array
 */
async function readFile(file: File): Promise<Uint8Array> {
  const buf = await file.arrayBuffer()
  return new Uint8Array(buf)
}

export interface DmAttachment {
  type: 'image' | 'file'
  url: string
  name: string
  size: number
  mimeType: string
  width?: number
  height?: number
}

/**
 * Hook for encrypting and uploading files in DM conversations.
 */
export function useDmFileUpload() {
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState('')

  const uploadEncryptedFile = useCallback(async (
    file: File,
    sharedSecret: CryptoKey,
    tokenId: number
  ): Promise<DmAttachment | null> => {
    setIsUploading(true)
    setUploadProgress('Preparing...')

    try {
      let data: Uint8Array
      let mimeType = file.type
      let width: number | undefined
      let height: number | undefined

      // Compress images
      if (file.type.startsWith('image/') && file.type !== 'image/gif') {
        setUploadProgress('Compressing...')
        const compressed = await compressImage(file)
        data = compressed.data
        mimeType = compressed.mimeType
        width = compressed.width
        height = compressed.height
      } else {
        data = await readFile(file)
      }

      // Check size after compression
      if (data.length > MAX_FILE_SIZE) {
        throw new Error(`File too large (${(data.length / 1024 / 1024).toFixed(1)}MB, max 10MB)`)
      }

      // Encrypt
      setUploadProgress('Encrypting...')
      const encrypted = await encryptBinary(data, sharedSecret)

      // Upload
      setUploadProgress('Uploading...')
      const response = await fetch('/api/upload/encrypted?tokenId=' + tokenId, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          ...getAuthHeaders(),
        },
        body: encrypted,
      })

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Upload failed' }))
        throw new Error(err.error || 'Upload failed')
      }

      const result = await response.json()

      return {
        type: file.type.startsWith('image/') ? 'image' : 'file',
        url: result.url,
        name: file.name,
        size: data.length,
        mimeType,
        width,
        height,
      }
    } catch (err: any) {
      console.error('[DM Upload] Error:', err)
      throw err
    } finally {
      setIsUploading(false)
      setUploadProgress('')
    }
  }, [])

  return { uploadEncryptedFile, isUploading, uploadProgress }
}

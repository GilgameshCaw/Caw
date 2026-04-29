import { useState, useCallback } from 'react'
import { encryptBinary } from '~/services/DmCryptoService'
import { getAuthHeaders } from '~/api/client'
import { compressImage } from '~/utils/compressImage'

// Max ENCRYPTED blob size accepted server-side. Cleartext is compressed
// client-side via the 'dm' preset (~750KB max), so 5MB encrypted leaves
// generous headroom for the AES-GCM overhead and any pre-compression GIFs.
const MAX_ENCRYPTED_SIZE = 5 * 1024 * 1024

/** Read an image's natural dimensions without decoding it twice. */
async function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image'))
    }
    img.src = url
  })
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
      let toUpload: File = file
      let width: number | undefined
      let height: number | undefined

      // Compress images via the shared helper. Must happen BEFORE encryption —
      // server can't recompress an opaque encrypted blob.
      if (file.type.startsWith('image/')) {
        setUploadProgress('Compressing...')
        toUpload = await compressImage(file, 'dm')
        try {
          const dims = await readImageDimensions(toUpload)
          width = dims.width
          height = dims.height
        } catch {
          // dimensions are best-effort; uploads still work without them
        }
      }

      const data = new Uint8Array(await toUpload.arrayBuffer())
      const mimeType = toUpload.type || file.type

      // Encrypt
      setUploadProgress('Encrypting...')
      const encrypted = await encryptBinary(data, sharedSecret)

      // Size check is on the ENCRYPTED blob — that's what hits the server cap.
      if (encrypted.byteLength > MAX_ENCRYPTED_SIZE) {
        throw new Error(`File too large (${(encrypted.byteLength / 1024 / 1024).toFixed(1)}MB encrypted, max ${MAX_ENCRYPTED_SIZE / 1024 / 1024}MB)`)
      }

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

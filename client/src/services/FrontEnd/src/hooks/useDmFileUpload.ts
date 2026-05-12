import { useState, useCallback } from 'react'
import { encryptBinary, generateRandomAesKey, sealKeyForRecipients } from '~/services/DmCryptoService'
import { getAuthHeaders } from '~/api/client'
import { compressImage } from '~/utils/compressImage'
import { compressVideo } from '~/utils/compressVideo'

// Max ENCRYPTED blob size accepted server-side. Cleartext is compressed
// client-side via the 'dm' preset (~750KB max), so 5MB encrypted leaves
// generous headroom for the AES-GCM overhead and any pre-compression GIFs.
const MAX_ENCRYPTED_SIZE = 5 * 1024 * 1024

// Pre-flight DM video cap (cleartext). DMs are 1:1 — short clips only.
// 3MB cleartext gives the compressor breathing room over its 2.5MB
// target without bumping into the 5MB encrypted server cap (AES-GCM
// overhead is ~16 bytes per chunk, negligible). Posts carry a higher
// cap; the error nudges users toward Posts for longer videos.
const MAX_DM_VIDEO_BYTES = 3 * 1024 * 1024

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
  type: 'image' | 'video' | 'file'
  url: string
  name: string
  size: number
  mimeType: string
  width?: number
  height?: number
  /**
   * Per-recipient sealed AES key. The attachment binary is encrypted
   * once with a random AES key; that random key is then sealed N times
   * (one entry per group member, including the sender for self-decrypt
   * on reload). Receiver looks up `sealedKeys[myTokenId]`, unseals it
   * with their own ECDH pair key against the sender, and uses the
   * recovered key to decrypt the binary.
   *
   * For DMs (1:1), `sealedKeys` has exactly two entries (peer + self);
   * the shape is identical to groups, so the renderer doesn't branch.
   */
  sealedKeys: Record<number, string>
}

export interface DmRecipient {
  userId: number
  publicKey: string
}

/**
 * Hook for encrypting and uploading files in DM conversations.
 */
export function useDmFileUpload() {
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState('')

  /**
   * Encrypt the file with a fresh random AES key, upload the encrypted
   * binary, then seal the random key per recipient. Recipients include
   * the sender so they can re-decrypt their own messages on reload.
   *
   * For DMs (1:1) pass `recipients = [peer, self]`.
   * For groups pass every active member (incl. self).
   *
   * Caller must hold their own DM identity privateKey — used to compute
   * the ECDH pair key for sealing each recipient slot.
   */
  const uploadEncryptedFile = useCallback(async (
    file: File,
    myPrivateKey: Uint8Array,
    recipients: DmRecipient[],
    tokenId: number,
  ): Promise<DmAttachment | null> => {
    setIsUploading(true)
    setUploadProgress('Preparing...')

    try {
      let toUpload: File = file
      let width: number | undefined
      let height: number | undefined

      // Transcode oversized videos. DM cap is tighter than posts (1:1
      // channel — long-form video isn't a fit), and the dm preset's
      // bitrate target reflects that.
      if (file.type.startsWith('video/') && file.size > MAX_DM_VIDEO_BYTES) {
        setUploadProgress('Compressing video…')
        try {
          const result = await compressVideo(file, 'dm')
          if (result.file.size > MAX_DM_VIDEO_BYTES) {
            throw new Error(`Video still too large after compression (${(result.file.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_DM_VIDEO_BYTES / 1024 / 1024}MB). Try a shorter clip — or post it instead.`)
          }
          toUpload = result.file
        } catch (err) {
          if (err instanceof Error) throw err
          throw new Error('Video compression failed. Try a shorter clip.')
        }
      }

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

      // Encrypt with a fresh random AES key. The key itself gets sealed
      // per recipient below; the binary on disk is a single ciphertext
      // every recipient shares.
      setUploadProgress('Encrypting...')
      const { raw: rawAesKey, key: attachmentKey } = await generateRandomAesKey()
      const encrypted = await encryptBinary(data, attachmentKey)
      const sealedKeys = await sealKeyForRecipients(rawAesKey, myPrivateKey, recipients)

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
        type: file.type.startsWith('image/')
          ? 'image'
          : file.type.startsWith('video/')
            ? 'video'
            : 'file',
        url: result.url,
        name: file.name,
        size: data.length,
        mimeType,
        width,
        height,
        sealedKeys,
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

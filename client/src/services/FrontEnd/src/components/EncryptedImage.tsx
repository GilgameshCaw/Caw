import React, { useEffect, useState } from 'react'
import { decryptBinary } from '~/services/DmCryptoService'
import ImageLightbox from './ImageLightbox'

interface EncryptedImageProps {
  url: string
  sharedSecret: CryptoKey | null
  mimeType?: string
  alt?: string
  className?: string
}

/**
 * Fetches an encrypted blob, decrypts it client-side, and renders as an image.
 */
const EncryptedImage: React.FC<EncryptedImageProps> = ({ url, sharedSecret, mimeType = 'image/webp', alt = 'Encrypted image', className }) => {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [lightboxOpen, setLightboxOpen] = useState(false)

  useEffect(() => {
    if (!sharedSecret) return

    let cancelled = false
    let blobUrl: string | null = null

    const fetchAndDecrypt = async () => {
      try {
        const response = await fetch(url)
        if (!response.ok) throw new Error('Fetch failed')
        const encrypted = new Uint8Array(await response.arrayBuffer())
        const decrypted = await decryptBinary(encrypted, sharedSecret)
        if (cancelled) return
        const blob = new Blob([decrypted], { type: mimeType })
        blobUrl = URL.createObjectURL(blob)
        setObjectUrl(blobUrl)
      } catch (err) {
        console.error('[EncryptedImage] Decrypt failed:', err)
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchAndDecrypt()

    return () => {
      cancelled = true
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [url, sharedSecret, mimeType])

  if (loading) {
    return (
      <div className={`animate-pulse bg-white/10 rounded-lg ${className || 'w-[200px] h-[150px]'}`} />
    )
  }

  if (error || !objectUrl) {
    return (
      <div className="text-xs text-red-400 p-2 rounded bg-red-900/20">
        Failed to decrypt {mimeType.startsWith('video/') ? 'video' : 'image'}
      </div>
    )
  }

  // Dispatch on mimeType so a single component handles encrypted images,
  // GIFs, and videos. The fetch / decrypt / blob-url flow above is
  // identical for all three; only the rendered element differs.
  if (mimeType.startsWith('video/')) {
    return (
      <video
        src={objectUrl}
        controls
        playsInline
        loop
        muted
        className={className || 'max-w-[240px] max-h-[240px] rounded-lg'}
      />
    )
  }
  // Image case: click to open the lightbox. We re-use the same blob URL
  // for the modal — the data is already decrypted in memory, no need to
  // re-fetch + re-decrypt. No `largeSrc` because encrypted attachments
  // only have one variant (server can't recompress an opaque blob).
  return (
    <>
      <img
        src={objectUrl}
        alt={alt}
        className={`${className || 'max-w-[240px] max-h-[240px] rounded-lg object-contain'} cursor-zoom-in`}
        loading="lazy"
        onClick={(e) => {
          e.stopPropagation()
          setLightboxOpen(true)
        }}
      />
      <ImageLightbox
        src={objectUrl}
        alt={alt}
        isOpen={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
      />
    </>
  )
}

export default EncryptedImage

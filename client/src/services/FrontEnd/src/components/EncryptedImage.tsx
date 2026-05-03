import React, { useEffect, useState } from 'react'
import { decryptBinary } from '~/services/DmCryptoService'
import ImageLightbox from './ImageLightbox'

interface EncryptedImageProps {
  url: string
  sharedSecret: CryptoKey | null
  mimeType?: string
  alt?: string
  className?: string
  /** Notifies the parent when the decrypt path fails so the parent can
   * swap its wrapper layout (the success path is image-shaped with an
   * absolute-positioned timestamp; the failure path is text-shaped and
   * needs the timestamp inline so it doesn't overlap the error label). */
  onError?: () => void
}

/**
 * Fetches an encrypted blob, decrypts it client-side, and renders as an image.
 */
const EncryptedImage: React.FC<EncryptedImageProps> = ({ url, sharedSecret, mimeType = 'image/webp', alt = 'Encrypted image', className, onError }) => {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  // For videos: even after the blob URL exists, the browser still has
  // to parse metadata + buffer enough to show a frame. Show a small
  // spinner over the placeholder until `onLoadedData` fires (more
  // reliable than `onLoadedMetadata` for "actually has a paintable
  // frame" — Safari in particular often fires metadata well before).
  const [videoReady, setVideoReady] = useState(false)

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
        if (!cancelled) {
          setError(true)
          onError?.()
        }
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
      <div className={`relative ${className || 'max-w-[240px] max-h-[240px]'} rounded-lg overflow-hidden`}>
        <video
          src={objectUrl}
          controls
          playsInline
          loop
          muted
          preload="metadata"
          onLoadedData={() => setVideoReady(true)}
          className={`${className || 'max-w-[240px] max-h-[240px]'} rounded-lg block`}
        />
        {!videoReady && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none">
            <div className="w-6 h-6 rounded-full border-2 border-white/30 border-t-white animate-spin" />
          </div>
        )}
      </div>
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

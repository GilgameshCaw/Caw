import React, { useEffect, useState } from 'react'
import {
  decryptBinary,
  unsealAttachmentKey,
  computeSharedSecretForPeer,
  getCachedPrivateKey,
} from '~/services/DmCryptoService'
import { isCanonicalEncryptedUploadUrl } from '~/utils/uploadUrl'
import ImageLightbox from './ImageLightbox'

interface EncryptedImageProps {
  url: string
  /**
   * The recipient's sealed copy of the per-attachment AES key (base64).
   * The attachment binary was encrypted ONCE with a random AES key; that
   * key was then sealed N times — one per recipient. The receiver picks
   * their slot before passing it here.
   */
  sealedKey: string
  /**
   * The MESSAGE SENDER's tokenId + publicKey. Used to derive the ECDH
   * pair key that unseals `sealedKey`. Same pair-key shape that text
   * messages decrypt with — every recipient unseals their own slot
   * against the sender, NOT against some single conversation key.
   */
  senderTokenId: number
  senderPublicKey: string
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
 * Fetches an encrypted blob, unseals the per-recipient AES key, decrypts
 * the blob, and renders as image / GIF / video.
 */
const EncryptedImage: React.FC<EncryptedImageProps> = ({ url, sealedKey, senderTokenId, senderPublicKey, mimeType = 'image/webp', alt = 'Encrypted image', className, onError }) => {
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
    if (!sealedKey || !senderPublicKey) return

    let cancelled = false
    let blobUrl: string | null = null

    const fetchAndDecrypt = async () => {
      try {
        // Validate the URL by PATH SHAPE before fetching: encrypted DM
        // attachments are stored under /uploads/encrypted/<16hex>(.<ext>)?
        // by the upload pipeline (randomBytes(8).toString('hex')). Without
        // this gate, a malicious DM sender could embed any URL
        // (https://attacker.tld/track, http://192.168.1.1/admin, etc.)
        // and the receiver's browser would emit a GET that leaks IP/UA
        // or probes their LAN. Mirrors the project-wide URL sanitizer
        // convention (validate by path shape, not host equality).
        if (!isCanonicalEncryptedUploadUrl(url)) {
          throw new Error('URL does not match the canonical encrypted-upload shape')
        }

        // Derive the ECDH pair key with the sender (cached internally by
        // sharedSecretByPeer keyed on senderTokenId), then unseal our
        // per-attachment AES key with it. The binary is encrypted once
        // and shared by every recipient; only the sealed-key slot is
        // per-recipient.
        const myPrivateKey = getCachedPrivateKey()
        if (!myPrivateKey) throw new Error('DM identity key not available')
        const pairKey = await computeSharedSecretForPeer(myPrivateKey, senderTokenId, senderPublicKey)
        const attachmentKey = await unsealAttachmentKey(sealedKey, pairKey)

        const response = await fetch(url)
        if (!response.ok) throw new Error('Fetch failed')
        const encrypted = new Uint8Array(await response.arrayBuffer())
        const decrypted = await decryptBinary(encrypted, attachmentKey)
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
  }, [url, sealedKey, senderTokenId, senderPublicKey, mimeType])

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

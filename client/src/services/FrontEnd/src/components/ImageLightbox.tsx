import React, { useEffect, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { HiOutlineX } from 'react-icons/hi'
import { acquireScrollLock, releaseScrollLock } from '~/utils/scrollLock'

interface ImageLightboxProps {
  /** Currently-rendered (small / inline) image URL. Used as the immediate
   *  src so the modal opens with content already on screen, then upgrades
   *  to `largeSrc` when that finishes loading. */
  src: string
  /** Optional larger variant (e.g. the 2048px feed-image lightbox URL).
   *  Skip for DM blob URLs and external images where there's only one. */
  largeSrc?: string
  alt?: string
  isOpen: boolean
  onClose: () => void
  /** Optional extra classes applied to the <img>. */
  imgClassName?: string
}

/**
 * Click-to-expand image modal. Same component for feed images and DM
 * images — DMs pass an already-decrypted blob URL as `src` and skip
 * `largeSrc` (only one variant exists for encrypted attachments).
 *
 * Why `largeSrc` is best-effort: the variant may not exist on the
 * server (uploaded before the variant system shipped, and the avatar
 * backfill doesn't cover post images). The img onError handler falls
 * back to `src` so a missing variant still shows the inline image at
 * full viewport size, which is still a visible improvement over no
 * lightbox at all.
 *
 * Lightbox renders via portal so it's never clipped by post / feed-item
 * overflow rules.
 */
const ImageLightbox: React.FC<ImageLightboxProps> = ({ src, largeSrc, alt = '', isOpen, onClose, imgClassName }) => {
  // Start with the small src so the modal has something to show
  // immediately, then swap to largeSrc once it's available. If largeSrc
  // 404s the onError handler keeps us on `src`.
  const [currentSrc, setCurrentSrc] = useState(largeSrc || src)
  const [largeFailed, setLargeFailed] = useState(false)

  // Touch state for swipe-down-to-close on mobile.
  const touchStartY = useRef<number | null>(null)
  const touchDeltaY = useRef(0)

  useEffect(() => {
    setCurrentSrc(largeSrc || src)
    setLargeFailed(false)
  }, [src, largeSrc])

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handler)
    acquireScrollLock()
    return () => {
      document.removeEventListener('keydown', handler)
      releaseScrollLock()
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  const handleBackdropMouseDown = (e: React.MouseEvent) => {
    // Only close when the click landed on the backdrop itself, not the image.
    if (e.target === e.currentTarget) onClose()
  }

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY
    touchDeltaY.current = 0
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartY.current === null) return
    touchDeltaY.current = e.touches[0].clientY - touchStartY.current
  }

  const handleTouchEnd = () => {
    // Swipe down ≥ 100px to dismiss.
    if (touchDeltaY.current > 100) onClose()
    touchStartY.current = null
    touchDeltaY.current = 0
  }

  const content = (
    <div
      className="fixed inset-0 z-[9999] bg-black/90 flex items-center justify-center p-4"
      onMouseDown={handleBackdropMouseDown}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 p-2 rounded-full bg-black/50 text-white/80 hover:text-white hover:bg-black/70 transition-colors cursor-pointer z-10"
        aria-label="Close"
      >
        <HiOutlineX className="w-6 h-6" />
      </button>
      <img
        src={currentSrc}
        alt={alt}
        className={[
          'max-w-[95vw] max-h-[95vh] object-contain',
          imgClassName ?? 'rounded'
        ].join(' ')}
        onClick={e => e.stopPropagation()}
        onError={() => {
          // Large variant 404? Drop to the inline `src` once and stay there.
          if (largeSrc && currentSrc === largeSrc && !largeFailed) {
            setLargeFailed(true)
            setCurrentSrc(src)
          }
        }}
      />
    </div>
  )

  return createPortal(content, document.body)
}

export default ImageLightbox

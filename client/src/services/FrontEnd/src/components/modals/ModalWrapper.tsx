import React, { useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTheme } from '~/hooks/useTheme'

// Module-level scroll-lock state so nested modals don't fight: only
// the first modal to open applies the lock + snapshots scrollY, and
// only the last to close restores. Without this, opening modal-B
// while modal-A is open would re-snapshot scrollY=0 (body is
// position:fixed so window.scrollY reads 0), and closing B would
// leave A holding the wrong restore target.
let scrollLockCount = 0
let savedScrollY = 0
let savedStyles: { overflow: string; position: string; top: string; width: string } | null = null

// iOS Safari ignores `body { overflow: hidden }` and needs the harsher
// `position:fixed; top:-scrollY` trick. Everywhere else, the harsh trick
// causes layout drift for any descendant that uses `position: fixed`
// without explicit top/left coords — those resolve to "auto" which is
// "where I would have been in flow", and shifting the body via top:-y
// drags them with it (e.g. left/right sidebars jumped down by ~scrollY).
function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const isIos = /iP(hone|od|ad)/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document)
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)
  return isIos && isSafari
}

function applyScrollLock() {
  if (scrollLockCount === 0) {
    savedScrollY = window.scrollY
    const body = document.body
    savedStyles = {
      overflow: body.style.overflow,
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
    }
    body.style.overflow = 'hidden'
    if (isIosSafari()) {
      body.style.position = 'fixed'
      body.style.top = `-${savedScrollY}px`
      body.style.width = '100%'
    }
  }
  scrollLockCount++
}

function releaseScrollLock() {
  scrollLockCount = Math.max(0, scrollLockCount - 1)
  if (scrollLockCount === 0 && savedStyles) {
    const body = document.body
    const wasIosLock = body.style.position === 'fixed'
    body.style.overflow = savedStyles.overflow
    body.style.position = savedStyles.position
    body.style.top = savedStyles.top
    body.style.width = savedStyles.width
    savedStyles = null
    if (wasIosLock) {
      window.scrollTo(0, savedScrollY)
    }
  }
}

interface ModalWrapperProps {
  isOpen: boolean
  onClose: () => void
  children: React.ReactNode
  /** Width class for the modal container (default: 'max-w-md') */
  maxWidth?: string
  /** Whether clicking outside should close the modal (default: true) */
  closeOnClickOutside?: boolean
  /** Whether pressing Escape should close the modal (default: true) */
  closeOnEscape?: boolean
  /** Additional classes for the modal container */
  className?: string
  /** Z-index for backdrop (default: 50). Modal will use z+10 */
  zIndex?: number
  /** Whether to render using React portal (default: false) */
  usePortal?: boolean
  /** Custom background color for backdrop (default: 'bg-black/70') */
  backdropClass?: string
}

/**
 * Reusable modal wrapper that handles:
 * - Escape key to close
 * - Click outside to close
 * - Dark/light mode styling
 * - Focus trapping (prevents background scroll)
 */
const ModalWrapper: React.FC<ModalWrapperProps> = ({
  isOpen,
  onClose,
  children,
  maxWidth = 'max-w-md',
  closeOnClickOutside = true,
  closeOnEscape = true,
  className = '',
  zIndex = 50,
  usePortal = true,
  backdropClass
}) => {
  const { isDark } = useTheme()
  const modalRef = useRef<HTMLDivElement>(null)

  // Handle Escape key
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (closeOnEscape && e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }, [closeOnEscape, onClose])

  // Handle click outside — use mousedown so a drag started inside the modal
  // and released on the backdrop does not close it
  const handleBackdropMouseDown = (e: React.MouseEvent) => {
    if (closeOnClickOutside && e.target === e.currentTarget) {
      onClose()
    }
  }

  // Add/remove event listener and prevent body scroll. iOS Safari
  // ignores body { overflow: hidden } — only position:fixed + a
  // negative top reliably stops the page scrolling under the modal.
  useEffect(() => {
    if (!isOpen) return

    document.addEventListener('keydown', handleKeyDown)
    applyScrollLock()

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      releaseScrollLock()
    }
  }, [isOpen, handleKeyDown])

  if (!isOpen) return null

  const effectiveBackdrop = backdropClass ?? (isDark ? 'bg-black/70' : 'bg-black/40')

  const modalContent = (
    <div
      className={`fixed inset-0 ${effectiveBackdrop} flex items-center justify-center p-4`}
      style={{ zIndex }}
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        ref={modalRef}
        className={`w-full ${maxWidth} rounded-2xl transition-all duration-300 ${
          isDark ? 'bg-black border border-yellow-500/30' : 'bg-white border border-gray-200'
        } ${className}`}
        onMouseDown={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )

  if (usePortal) {
    return createPortal(modalContent, document.body)
  }

  return modalContent
}

export default ModalWrapper

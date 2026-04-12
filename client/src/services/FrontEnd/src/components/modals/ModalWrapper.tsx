import React, { useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTheme } from '~/hooks/useTheme'

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
  backdropClass = 'bg-black/70'
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

  // Handle click outside
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (closeOnClickOutside && e.target === e.currentTarget) {
      onClose()
    }
  }

  // Add/remove event listener and prevent body scroll
  useEffect(() => {
    if (!isOpen) return

    document.addEventListener('keydown', handleKeyDown)

    // Prevent body scroll when modal is open
    const originalOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = originalOverflow
    }
  }, [isOpen, handleKeyDown])

  if (!isOpen) return null

  const modalContent = (
    <div
      className={`fixed inset-0 ${backdropClass} flex items-center justify-center p-4`}
      style={{ zIndex }}
      onClick={handleBackdropClick}
    >
      <div
        ref={modalRef}
        className={`w-full ${maxWidth} rounded-2xl transition-all duration-300 ${
          isDark ? 'bg-black border border-yellow-500/30' : 'bg-white border border-gray-200'
        } ${className}`}
        onClick={e => e.stopPropagation()}
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

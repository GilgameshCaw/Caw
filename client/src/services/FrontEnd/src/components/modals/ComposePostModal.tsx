import React, { useEffect, useState } from 'react'
import { HiX } from 'react-icons/hi'
import PostForm from '~/components/PostForm'
import { createPortal } from 'react-dom'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { acquireScrollLock, releaseScrollLock } from '~/utils/scrollLock'

interface ComposePostModalProps {
  isOpen: boolean
  onClose: () => void
}

const ComposePostModal: React.FC<ComposePostModalProps> = ({ isOpen, onClose }) => {
  const { isDark } = useTheme()
  const t = useT()

  // Viewport changes presentation and dismissal behavior, never the form
  // ancestry or Portal target: an open composer must retain its local state.
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches
  )
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 768px)')
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  // Lock body scroll while the mobile fullscreen sheet is open.
  // Lock scroll while the compose sheet is open (iOS-aware via shared util).
  useEffect(() => {
    if (!isOpen) return
    acquireScrollLock()
    return () => { releaseScrollLock() }
  }, [isOpen])

  // Preserve the desktop Escape behavior without applying it to the mobile sheet.
  useEffect(() => {
    if (!isOpen || !isDesktop) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, isDesktop, onClose])

  if (!isOpen) return null

  // Keep one form under one Portal for the whole open session. Responsive
  // classes switch the shell; composeMode preserves the existing form layouts.
  return createPortal(
    <div
      className={`fixed inset-x-0 bottom-0 top-16 z-[70] flex flex-col md:inset-0 md:z-50 md:items-center md:justify-center md:p-4 ${
        isDark ? 'md:bg-black/70' : 'md:bg-black/40'
      }`}
      onMouseDown={e => {
        if (isDesktop && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`flex flex-1 min-h-0 flex-col overflow-hidden md:flex-initial md:overflow-y-auto md:w-full md:max-w-xl md:max-h-[calc(100dvh-2rem)] md:rounded-2xl md:-translate-x-[2.75rem] ${
          isDark ? 'bg-black text-white md:border md:border-yellow-500/30' : 'bg-white text-black md:border md:border-gray-200'
        }`}
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center px-3 py-2 shrink-0 md:hidden">
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className={`p-2 rounded-full transition-colors cursor-pointer ${
              isDark ? 'hover:bg-white/10 text-white' : 'hover:bg-gray-100 text-black'
            }`}
          >
            <HiX className="w-6 h-6" />
          </button>
        </div>
        <div className="flex-1 min-h-0 flex flex-col">
          <PostForm onSuccess={onClose} placeholder={t('compose.placeholder')} composeMode={!isDesktop} keepInputVisible />
        </div>
      </div>
    </div>,
    document.body
  )
}

export default ComposePostModal

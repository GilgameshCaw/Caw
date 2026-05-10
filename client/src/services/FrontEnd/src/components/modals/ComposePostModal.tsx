import React, { useEffect, useState } from 'react'
import { HiX } from 'react-icons/hi'
import PostForm from '~/components/PostForm'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'

interface ComposePostModalProps {
  isOpen: boolean
  onClose: () => void
}

const ComposePostModal: React.FC<ComposePostModalProps> = ({ isOpen, onClose }) => {
  const { isDark } = useTheme()
  const t = useT()

  // Track viewport — desktop uses ModalWrapper (portaled to body, can't be
  // hidden via parent className), mobile uses an in-tree fullscreen sheet.
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
  // iOS Safari ignores body { overflow: hidden } — only position:fixed
  // + a negative top reliably stops the page scrolling under the sheet.
  // Mirrors the ModalWrapper scroll-lock pattern so behavior is
  // consistent across modals + this in-tree sheet.
  useEffect(() => {
    if (!isOpen) return
    const scrollY = window.scrollY
    const body = document.body
    const original = {
      overflow: body.style.overflow,
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
    }
    body.style.overflow = 'hidden'
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.width = '100%'
    return () => {
      body.style.overflow = original.overflow
      body.style.position = original.position
      body.style.top = original.top
      body.style.width = original.width
      window.scrollTo(0, scrollY)
    }
  }, [isOpen])

  if (!isOpen) return null

  // Desktop: keep the existing modal experience.
  // Mobile: fullscreen Twitter-style sheet — no backdrop padding, own header.
  const backdropClass = `bg-black/85 ${isDark ? 'md:bg-black/70' : 'md:bg-black/40'}`

  if (isDesktop) {
    return (
      <ModalWrapper
        isOpen={isOpen}
        onClose={onClose}
        maxWidth="max-w-xl"
        className="overflow-hidden md:-translate-x-[2.75rem]"
        backdropClass={backdropClass}
      >
        <PostForm onSuccess={onClose} placeholder={t('compose.placeholder')} />
      </ModalWrapper>
    )
  }

  return (
    <div
      className={`fixed left-0 right-0 bottom-0 z-[70] flex flex-col ${
        isDark ? 'bg-black text-white' : 'bg-white text-black'
      }`}
      style={{ top: '4rem' }}
    >
      <div className="flex items-center px-3 py-2 shrink-0">
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
      {/* PostForm fills the remaining height. Inside, composeMode +
          mobile flips PostForm into a flex layout where the textarea
          scrolls and the toolbar/toggles stick to the bottom — see
          PostForm's outer wrapper below. */}
      <div className="flex-1 min-h-0 flex flex-col">
        <PostForm onSuccess={onClose} placeholder={t('compose.placeholder')} composeMode />
      </div>
    </div>
  )
}

export default ComposePostModal

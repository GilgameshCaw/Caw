import React from 'react'
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
  // Mobile: stronger backdrop so the page underneath fully recedes.
  // Desktop: keep the existing theme defaults.
  const backdropClass = `bg-black/85 ${isDark ? 'md:bg-black/70' : 'md:bg-black/40'}`
  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} maxWidth="max-w-xl" className="overflow-hidden md:-translate-x-[2.75rem]" backdropClass={backdropClass}>
      <PostForm onSuccess={onClose} placeholder={t('compose.placeholder')} />
    </ModalWrapper>
  )
}

export default ComposePostModal

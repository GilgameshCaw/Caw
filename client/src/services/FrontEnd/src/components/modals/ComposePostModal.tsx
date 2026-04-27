import React from 'react'
import PostForm from '~/components/PostForm'
import ModalWrapper from './ModalWrapper'

interface ComposePostModalProps {
  isOpen: boolean
  onClose: () => void
}

const ComposePostModal: React.FC<ComposePostModalProps> = ({ isOpen, onClose }) => {
  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} maxWidth="max-w-xl" className="overflow-hidden md:-translate-x-[2.75rem]">
      <PostForm onSuccess={onClose} placeholder="Write something.." />
    </ModalWrapper>
  )
}

export default ComposePostModal

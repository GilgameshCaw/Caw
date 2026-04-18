import { getUserAvatar } from "~/utils/defaultAvatar"
// src/components/CommentModal.tsx
import React from 'react'
import type { CawItem } from '~/types'
import PostForm from '~/components/PostForm'
import ContentWithHashtags from '~/components/ContentWithHashtags'
import { useTheme } from '~/hooks/useTheme'
import ModalWrapper from './ModalWrapper'
import ModalHeader from './ModalHeader'


interface CommentModalProps {
  isOpen: boolean
  caw: CawItem
  onClose: () => void
  onReplySubmitted?: () => void
}


export const CommentModal: React.FC<CommentModalProps> = ({ isOpen, caw, onClose, onReplySubmitted }) => {
  const { isDark } = useTheme()

  const handleSuccess = () => {
    // Call the onReplySubmitted callback first (to set pending state)
    if (onReplySubmitted) {
      onReplySubmitted()
    }
    // Then close the modal
    onClose()
  }

  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} maxWidth="max-w-2xl">
      <ModalHeader title="Reply" onClose={onClose} />

      {/* Original Caw */}
      <div className={`px-4 pt-4 ${isDark ? 'text-white' : 'text-black'}`}>
        <div className="flex items-start space-x-3">
          <img
            src={getUserAvatar(caw.user)}
            alt={`${caw.user.username} avatar`}
            className="w-10 h-10 rounded-full object-cover"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center space-x-2">
              <span className="font-semibold">{caw.user.displayName || caw.user.username}</span>
              <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                @{caw.user.username}
              </span>
            </div>
            <ContentWithHashtags
              content={caw.content}
              className={`mt-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}
            />
            <p className={`mt-2 text-sm ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              Replying to <span className="text-blue-500">@{caw.user.username}</span>
            </p>
          </div>
        </div>
      </div>

      {/* Reply Form */}
      <div className="p-4">
        <PostForm
          replyTo={caw}
          onSuccess={handleSuccess}
        />
      </div>
    </ModalWrapper>
  )
}

export default CommentModal


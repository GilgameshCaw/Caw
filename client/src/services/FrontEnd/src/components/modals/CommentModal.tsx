// src/components/CommentModal.tsx
import React from 'react'
import { HiX } from 'react-icons/hi'
import type { CawItem } from '~/types'
import PostForm from '~/components/PostForm'
import ContentWithHashtags from '~/components/ContentWithHashtags'
import { useTheme } from '~/hooks/useTheme'


interface CommentModalProps {
  caw: CawItem
  onClose: () => void
  onReplySubmitted?: () => void
}


export const CommentModal: React.FC<CommentModalProps> = ({ caw, onClose, onReplySubmitted }) => {
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
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className={`w-full max-w-2xl rounded-2xl transition-all duration-300 ${
          isDark ? 'bg-black border border-yellow-500/30' : 'bg-white border border-gray-200'
        }`}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className={`flex items-center justify-between p-4 border-b ${
          isDark ? 'border-white/10' : 'border-gray-200'
        }`}>
          <h2 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-black'}`}>
            Reply
          </h2>
          <button
            onClick={onClose}
            className={`p-2 rounded-full transition-all duration-200 hover:bg-gray-500/20 ${
              isDark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-black'
            }`}
          >
            <HiX className="w-5 h-5" />
          </button>
        </div>

        {/* Original Caw */}
        <div className={`px-4 pt-4 ${isDark ? 'text-white' : 'text-black'}`}>
          <div className="flex items-start space-x-3">
            <img
              src={caw.user.avatarUrl || caw.user.image || "/images/logo.jpeg"}
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
      </div>
    </div>
  )
}

export default CommentModal


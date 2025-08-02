// src/components/QuoteModal.tsx
import React from 'react'
import { useModalStore } from '~/store/modalStore'
import PostForm from '~/components/PostForm'
import CloseIcon from '~/assets/images/close.svg?react'
import type { CawItem } from '~/types'


interface QuoteModalProps {
  caw: CawItem
  onClose: () => void
}


export const QuoteModal: React.FC<QuoteModalProps> = ({ caw, onClose }) => {

  return (
    <div
      className="modal-backdrop fixed inset-0 bg-[#0000002] flex items-center justify-start pt-40"
      onClick={onClose}
    >
      <div
        className="modal bg-[#0c0c0c] p-6 rounded-lg w-full max-w-lg relative"
        onClick={e => e.stopPropagation()}
      >
        <button
          className="absolute top-3 right-3 text-gray-500 hover:text-white"
          onClick={onClose}
        >
          <CloseIcon className="w-6 h-6" />
        </button>

        {/* use the same PostForm, passing replyTo */}
        <PostForm
          quote={caw}
          onSuccess={onClose}
        />

        {/* show original Caw */}
        <div className="mb-4 rounded-md border-4 border-gray-700 pl-4">
          <div className="font-bold">@{caw.user.username}</div>
          <p className="text-gray-300">{caw.content}</p>
        </div>
      </div>
    </div>
  )
}

export default QuoteModal


// src/components/CommentModal.tsx
import React, { useState } from 'react'
import { useSignAndSubmitAction } from '~/api/actions'
import CloseIcon                 from '~/assets/images/close.svg?react'
import { useTokenDataStore, useActiveToken } from "~/store/tokenDataStore";
import type { CawItem }          from '~/types'
import { useAccount } from "wagmi";
import PostForm from '~/components/PostForm'


interface CommentModalProps {
  caw: CawItem
  onClose: () => void
}


export const CommentModal: React.FC<CommentModalProps> = ({ caw, onClose }) => {
  return (
    <div
      className="modal-backdrop fixed inset-0 bg-[#0000002] flex items-center justify-start pt-40"
      onClick={onClose}
    >
      <div
        className="modal bg-[#0c0c0c] p-6 rounded-lg w-full max-w-md relative"
        onClick={e => e.stopPropagation()}
      >
        <button
          className="absolute top-3 right-3 text-gray-500 hover:text-white"
          onClick={onClose}
        >
          <CloseIcon className="w-6 h-6" />
        </button>

        {/* original Caw */}
        <div className="mb-4">
          <div className="font-bold">@{caw.user.username}</div>
          <p className="border-l-1 border-l-[#fff4] pt-1 pb-4 pl-3 ml-2 mt-1 text-gray-300">{caw.content}</p>
        </div>

        <PostForm
          replyTo={caw}
          onSuccess={onClose}
        />
      </div>
    </div>
  )
}

export default CommentModal


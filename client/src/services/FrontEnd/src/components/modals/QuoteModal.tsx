import { getUserAvatar } from "~/utils/defaultAvatar"
// src/components/QuoteModal.tsx
import React from 'react'
import PostForm from '~/components/PostForm'
import ContentWithHashtags from '~/components/ContentWithHashtags'
import type { CawItem } from '~/types'
import ModalWrapper from './ModalWrapper'
import ModalHeader from './ModalHeader'

interface QuoteModalProps {
  isOpen: boolean
  caw: CawItem
  onClose: () => void
  onSuccess?: () => void
}

import { formatTimeAgo } from '~/utils/formatTimeAgo'

// Helper to render images from imageData
function renderImages(imageData: string | null | undefined) {
  if (!imageData) return null

  if (imageData.startsWith('urls:')) {
    const urls = imageData.replace('urls:', '').split('|||')
    return (
      <div className={`mt-3 grid ${urls.length > 1 ? 'grid-cols-2 gap-2' : 'grid-cols-1'}`}>
        {urls.map((url, index) => (
          <div key={index} className="relative rounded-lg overflow-hidden">
            <img
              src={url}
              alt={`Image ${index + 1}`}
              className="w-full h-auto max-h-48 object-cover"
            />
          </div>
        ))}
      </div>
    )
  } else {
    const images = imageData.split('|||')
    return (
      <div className={`mt-3 grid ${images.length > 1 ? 'grid-cols-2 gap-2' : 'grid-cols-1'}`}>
        {images.map((imageBase64, index) => (
          <div key={index} className="relative rounded-lg overflow-hidden">
            <img
              src={`data:image/jpeg;base64,${imageBase64}`}
              alt={`Image ${index + 1}`}
              className="w-full h-auto max-h-48 object-cover"
            />
          </div>
        ))}
      </div>
    )
  }
}

export const QuoteModal: React.FC<QuoteModalProps> = ({ isOpen, caw, onClose, onSuccess }) => {
  return (
    <ModalWrapper
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="max-w-lg"
      zIndex={60}
      usePortal
      className="max-h-[90vh] overflow-y-auto shadow-2xl"
    >
      <ModalHeader
        title="Quote Post"
        onClose={onClose}
        borderClass="border-b border-yellow-500/20"
        forceDark
        className="sticky top-0 bg-black z-10"
      />

      {/* Content */}
      <div className="p-4">
        {/* Post Form */}
        <div className="mb-4">
          <PostForm
            quote={caw}
            onSuccess={onSuccess || onClose}
          />
        </div>

        {/* Quoted Caw Preview */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          {/* User info row */}
          <div className="flex items-center gap-3 mb-3">
            {/* Avatar */}
            <img
              src={getUserAvatar(caw.user)}
              alt={`${caw.user.username} avatar`}
              className="w-10 h-10 rounded-full object-cover"
            />

            {/* Name and username */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-white truncate">
                  {caw.user.displayName || caw.user.username}
                </span>
                <span className="text-white/50 text-sm truncate">
                  @{caw.user.username}
                </span>
                <span className="text-white/30 text-sm">
                  · {formatTimeAgo(caw.timestamp)}
                </span>
              </div>
            </div>
          </div>

          {/* Content */}
          <div className="text-white/90 text-sm leading-relaxed">
            <ContentWithHashtags content={caw.content} />
          </div>

          {/* Images if present */}
          {caw.hasImage && renderImages(caw.imageData)}

          {/* Video if present */}
          {caw.hasVideo && caw.videoData && (
            <div className="mt-3 rounded-lg overflow-hidden">
              <video
                src={caw.videoData.split('|||')[0]}
                className="w-full max-h-48 object-cover"
                controls={false}
                muted
                playsInline
              />
            </div>
          )}
        </div>
      </div>
    </ModalWrapper>
  )
}

export default QuoteModal

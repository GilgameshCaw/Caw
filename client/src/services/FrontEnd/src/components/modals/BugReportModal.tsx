import React, { useState, useRef } from 'react'
import ModalWrapper from './ModalWrapper'
import ModalHeader from './ModalHeader'
import { useTheme } from '~/hooks/useTheme'
import { useActiveToken } from '~/store/tokenDataStore'
import { apiFetch } from '~/api/client'
import { useFormSubmit } from '~/hooks/useFormSubmit'
import { HiOutlineX } from 'react-icons/hi'
import { themeBgSubtle, themeInput } from '~/utils/theme'

interface BugReportModalProps {
  isOpen: boolean
  onClose: () => void
}

type FeedbackType = 'bug' | 'feature'

const BugReportModal: React.FC<BugReportModalProps> = ({ isOpen, onClose }) => {
  const { isDark } = useTheme()
  const activeToken = useActiveToken()
  const [feedbackType, setFeedbackType] = useState<FeedbackType>('bug')
  const [description, setDescription] = useState('')
  const [images, setImages] = useState<File[]>([])
  const [previews, setPreviews] = useState<string[]>([])
  const { isSubmitting, submitted, error, setError, handleSubmit: formSubmit, reset: resetForm } = useFormSubmit()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)

  const addFiles = (files: File[]) => {
    const imageFiles = files.filter(f => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return
    if (images.length + imageFiles.length > 3) {
      setError('Maximum 3 images')
      return
    }
    const newImages = [...images, ...imageFiles].slice(0, 3)
    setImages(newImages)
    setPreviews(newImages.map(f => URL.createObjectURL(f)))
    setError('')
  }

  const handleImageAdd = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files || []))
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    addFiles(Array.from(e.dataTransfer.files))
  }

  const removeImage = (index: number) => {
    URL.revokeObjectURL(previews[index])
    setImages(prev => prev.filter((_, i) => i !== index))
    setPreviews(prev => prev.filter((_, i) => i !== index))
  }

  const handleSubmit = () => {
    if (!description.trim()) {
      setError(feedbackType === 'bug' ? 'Please describe the bug' : 'Please describe the feature')
      return
    }

    formSubmit(async () => {
      let imageUrls: string[] = []
      if (images.length > 0) {
        const formData = new FormData()
        images.forEach(img => formData.append('media', img))
        formData.append('tokenId', String(activeToken?.tokenId || 0))

        const { getAuthHeaders } = await import('~/api/client')
        const uploadRes = await fetch('/api/upload', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: formData
        })
        if (!uploadRes.ok) throw new Error('Image upload failed')
        const uploadData = await uploadRes.json()
        imageUrls = uploadData.urls || []
      }

      await apiFetch('/api/bug-reports', {
        method: 'POST',
        body: JSON.stringify({
          type: feedbackType,
          userId: activeToken?.tokenId || null,
          username: activeToken?.username || null,
          stakedAmount: activeToken?.stakedAmount?.toString() || null,
          description: description.trim(),
          imageUrls: imageUrls.length > 0 ? imageUrls.join('|||') : null,
          page: window.location.pathname,
          userAgent: navigator.userAgent
        })
      })
    })
  }

  const handleClose = () => {
    previews.forEach(p => URL.revokeObjectURL(p))
    setFeedbackType('bug')
    setDescription('')
    setImages([])
    setPreviews([])
    resetForm()
    onClose()
  }

  return (
    <ModalWrapper isOpen={isOpen} onClose={handleClose} maxWidth="max-w-lg" usePortal>
      <div
        className="p-6 relative"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragging && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-yellow-500/10 border-2 border-dashed border-yellow-500 rounded-xl pointer-events-none">
            <div className="text-center">
              <svg className="mx-auto h-8 w-8 text-yellow-500 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400">Drop here</p>
            </div>
          </div>
        )}
        <ModalHeader title="Feedback" onClose={handleClose} border={false} className="mb-4 px-0" />

        {/* Type toggle */}
        {!submitted && (
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => setFeedbackType('bug')}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                feedbackType === 'bug'
                  ? 'bg-red-500/20 text-red-400 border border-red-500/40'
                  : isDark ? 'bg-white/5 text-white/40 hover:bg-white/10' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              }`}
            >
              Bug Report
            </button>
            <button
              onClick={() => setFeedbackType('feature')}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                feedbackType === 'feature'
                  ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/40'
                  : isDark ? 'bg-white/5 text-white/40 hover:bg-white/10' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              }`}
            >
              Feature Request
            </button>
          </div>
        )}

        {submitted ? (
          <div className="text-center py-8">
            <div className="text-4xl mb-3">Thanks!</div>
            <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
              {feedbackType === 'bug' ? "Your bug report has been submitted. We'll look into it." : "Your feature request has been submitted. Thanks for the idea!"}
            </p>
            <button
              onClick={handleClose}
              className="mt-4 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            {/* User info */}
            {activeToken && (
              <div className={`text-xs mb-3 px-3 py-2 rounded-lg ${themeBgSubtle(isDark)} text-white/40`}>
                Reporting as @{activeToken.username} (staked: {activeToken.stakedAmount?.toString() || '0'} CAW)
              </div>
            )}

            {/* Description */}
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={feedbackType === 'bug' ? "Describe the bug... What happened? What did you expect?" : "Describe the feature you'd like to see..."}
              rows={4}
              className={`w-full px-3 py-2 rounded-lg border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${themeInput(isDark)}`}
            />

            {/* Image previews */}
            {previews.length > 0 && (
              <div className="flex gap-2 mt-3">
                {previews.map((src, i) => (
                  <div key={i} className="relative w-20 h-20">
                    <img src={src} className="w-full h-full object-cover rounded-lg" />
                    <button
                      onClick={() => removeImage(i)}
                      className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center text-xs cursor-pointer"
                    >
                      <HiOutlineX className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-between mt-4">
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleImageAdd}
                  className="hidden"
                />
                {images.length < 3 && (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className={`text-sm px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                      isDark
                        ? 'text-white/60 hover:bg-white/10'
                        : 'text-gray-500 hover:bg-gray-100'
                    }`}
                  >
                    + Attach screenshot
                  </button>
                )}
              </div>

              <button
                onClick={handleSubmit}
                disabled={isSubmitting || !description.trim()}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                  isSubmitting || !description.trim()
                    ? 'bg-blue-500/30 text-white/50 cursor-not-allowed'
                    : 'bg-blue-500 text-white hover:bg-blue-600'
                }`}
              >
                {isSubmitting ? 'Submitting...' : 'Submit'}
              </button>
            </div>

            {error && (
              <p className="text-red-500 text-xs mt-2">{error}</p>
            )}
          </>
        )}
      </div>
    </ModalWrapper>
  )
}

export default BugReportModal

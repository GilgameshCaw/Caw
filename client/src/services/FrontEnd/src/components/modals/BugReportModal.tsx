import React, { useState, useRef } from 'react'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useActiveToken } from '~/store/tokenDataStore'
import { apiFetch } from '~/api/client'
import { HiOutlineX } from 'react-icons/hi'

interface BugReportModalProps {
  isOpen: boolean
  onClose: () => void
}

const BugReportModal: React.FC<BugReportModalProps> = ({ isOpen, onClose }) => {
  const { isDark } = useTheme()
  const activeToken = useActiveToken()
  const [description, setDescription] = useState('')
  const [images, setImages] = useState<File[]>([])
  const [previews, setPreviews] = useState<string[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')
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

  const handleSubmit = async () => {
    if (!description.trim()) {
      setError('Please describe the bug')
      return
    }

    setIsSubmitting(true)
    setError('')

    try {
      // Upload images first if any
      let imageUrls: string[] = []
      if (images.length > 0) {
        const formData = new FormData()
        images.forEach(img => formData.append('media', img))
        formData.append('tokenId', String(activeToken?.tokenId || 0))

        const uploadRes = await fetch('/api/upload', {
          method: 'POST',
          body: formData
        })
        if (!uploadRes.ok) throw new Error('Image upload failed')
        const uploadData = await uploadRes.json()
        imageUrls = uploadData.urls || []
      }

      await apiFetch('/api/bug-reports', {
        method: 'POST',
        body: JSON.stringify({
          userId: activeToken?.tokenId || null,
          username: activeToken?.username || null,
          stakedAmount: activeToken?.stakedAmount?.toString() || null,
          description: description.trim(),
          imageUrls: imageUrls.length > 0 ? imageUrls.join('|||') : null,
          page: window.location.pathname,
          userAgent: navigator.userAgent
        })
      })

      setSubmitted(true)
    } catch (err) {
      console.error('Bug report submission failed:', err)
      setError('Failed to submit. Please try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleClose = () => {
    // Clean up previews
    previews.forEach(p => URL.revokeObjectURL(p))
    setDescription('')
    setImages([])
    setPreviews([])
    setError('')
    setSubmitted(false)
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
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            Report a Bug
          </h2>
          <button
            onClick={handleClose}
            className={`p-1 rounded-full transition-colors cursor-pointer ${
              isDark ? 'hover:bg-white/10 text-white/60' : 'hover:bg-gray-100 text-gray-400'
            }`}
          >
            <HiOutlineX className="w-5 h-5" />
          </button>
        </div>

        {submitted ? (
          <div className="text-center py-8">
            <div className="text-4xl mb-3">Thanks!</div>
            <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
              Your bug report has been submitted. We'll look into it.
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
              <div className={`text-xs mb-3 px-3 py-2 rounded-lg ${
                isDark ? 'bg-white/5 text-white/40' : 'bg-gray-50 text-gray-400'
              }`}>
                Reporting as @{activeToken.username} (staked: {activeToken.stakedAmount?.toString() || '0'} CAW)
              </div>
            )}

            {/* Description */}
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Describe the bug... What happened? What did you expect?"
              rows={4}
              className={`w-full px-3 py-2 rounded-lg border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${
                isDark
                  ? 'bg-white/5 border-white/10 text-white placeholder-white/30'
                  : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400'
              }`}
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

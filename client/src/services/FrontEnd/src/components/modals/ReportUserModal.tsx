import React, { useState, useRef } from 'react'
import { HiFlag, HiOutlinePhotograph, HiOutlineX } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'
import { apiFetch, getAuthHeaders } from '~/api/client'
import ModalWrapper from './ModalWrapper'

export type ReportReason = 'SPAM' | 'HARASSMENT' | 'INAPPROPRIATE' | 'SCAM' | 'OTHER'

interface ReportUserModalProps {
  isOpen: boolean
  onClose: () => void
  userId: number
  username: string
}

const REPORT_REASONS: { value: ReportReason; label: string; description: string }[] = [
  { value: 'SPAM', label: 'Spam', description: 'Unwanted messages or repetitive content' },
  { value: 'HARASSMENT', label: 'Harassment', description: 'Targeted abuse, threats, or bullying' },
  { value: 'INAPPROPRIATE', label: 'Inappropriate content', description: 'Graphic, violent, or adult content' },
  { value: 'SCAM', label: 'Scam', description: 'Attempting to defraud or deceive' },
  { value: 'OTHER', label: 'Other', description: 'Another issue not listed above' },
]

const ReportUserModal: React.FC<ReportUserModalProps> = ({ isOpen, onClose, userId, username }) => {
  const { isDark } = useTheme()
  const [selectedReason, setSelectedReason] = useState<ReportReason | null>(null)
  const [details, setDetails] = useState('')
  const [images, setImages] = useState<{ file: File; preview: string }[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleAddImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (images.length + files.length > 3) {
      setError('Maximum 3 images')
      return
    }
    const newImages = files.map(file => ({
      file,
      preview: URL.createObjectURL(file),
    }))
    setImages(prev => [...prev, ...newImages])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleRemoveImage = (idx: number) => {
    setImages(prev => {
      URL.revokeObjectURL(prev[idx].preview)
      return prev.filter((_, i) => i !== idx)
    })
  }

  const handleSubmit = async () => {
    if (!selectedReason) return
    setIsSubmitting(true)
    setError(null)

    try {
      // Upload images first if any
      let imageUrls: string[] = []
      if (images.length > 0) {
        const formData = new FormData()
        images.forEach(img => formData.append('media', img.file))
        formData.append('type', 'image')
        formData.append('tokenId', '0') // system upload

        const uploadRes = await fetch('/api/upload', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: formData,
        })
        if (uploadRes.ok) {
          const uploadData = await uploadRes.json()
          imageUrls = uploadData.urls || []
        }
      }

      // Submit the report
      await apiFetch('/api/reports/user', {
        method: 'POST',
        body: JSON.stringify({
          reportedUserId: userId,
          reportedUsername: username,
          reason: selectedReason,
          details: details || undefined,
          imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
        }),
      })

      setSubmitted(true)
    } catch (err: any) {
      setError(err.message || 'Failed to submit report')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleClose = () => {
    images.forEach(img => URL.revokeObjectURL(img.preview))
    setSelectedReason(null)
    setDetails('')
    setImages([])
    setError(null)
    setSubmitted(false)
    onClose()
  }

  return (
    <ModalWrapper isOpen={isOpen} onClose={handleClose} maxWidth="max-w-md" usePortal className="p-6">
      {submitted ? (
        <div className="text-center py-4">
          <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-3">
            <HiFlag className="w-6 h-6 text-green-400" />
          </div>
          <h2 className={`text-lg font-bold mb-2 ${isDark ? 'text-white' : 'text-black'}`}>
            Report Submitted
          </h2>
          <p className={`text-sm mb-4 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            Thank you for your report. Our team will review it.
          </p>
          <button
            onClick={handleClose}
            className="px-6 py-2 rounded-full font-medium bg-yellow-500 hover:bg-yellow-600 text-black cursor-pointer"
          >
            Done
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 mb-4">
            <div className={`p-2 rounded-full ${isDark ? 'bg-red-500/20' : 'bg-red-50'}`}>
              <HiFlag className="w-5 h-5 text-red-500" />
            </div>
            <h2 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-black'}`}>
              Report @{username}
            </h2>
          </div>

          <p className={`text-sm mb-4 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            Why are you reporting this user?
          </p>

          {/* Reason Selection */}
          <div className="space-y-2 mb-4">
            {REPORT_REASONS.map((reason) => (
              <button
                key={reason.value}
                onClick={() => setSelectedReason(reason.value)}
                className={`w-full text-left p-3 rounded-lg border transition-all cursor-pointer ${
                  selectedReason === reason.value
                    ? isDark ? 'border-red-500 bg-red-500/10' : 'border-red-500 bg-red-50'
                    : isDark ? 'border-white/10 hover:border-white/20 hover:bg-white/5' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                }`}
              >
                <div className={`font-medium ${isDark ? 'text-white' : 'text-black'}`}>{reason.label}</div>
                <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{reason.description}</div>
              </button>
            ))}
          </div>

          {/* Details */}
          <div className="mb-4">
            <label className={`block text-sm font-medium mb-2 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
              Additional details (optional)
            </label>
            <textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Provide any additional context..."
              rows={3}
              className={`w-full px-3 py-2 rounded-lg border resize-none transition-colors ${
                isDark ? 'bg-black border-white/20 text-white placeholder-gray-500' : 'bg-white border-gray-300 text-black placeholder-gray-400'
              } focus:outline-none focus:ring-1 focus:ring-red-500 focus:border-red-500`}
            />
          </div>

          {/* Image Evidence */}
          <div className="mb-4">
            <label className={`block text-sm font-medium mb-2 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
              Evidence (optional, up to 3 images)
            </label>
            <div className="flex gap-2 flex-wrap">
              {images.map((img, idx) => (
                <div key={idx} className="relative w-20 h-20 rounded-lg overflow-hidden">
                  <img src={img.preview} alt="" className="w-full h-full object-cover" />
                  <button
                    onClick={() => handleRemoveImage(idx)}
                    className="absolute top-0.5 right-0.5 p-0.5 rounded-full bg-black/60 text-white cursor-pointer"
                  >
                    <HiOutlineX className="w-3 h-3" />
                  </button>
                </div>
              ))}
              {images.length < 3 && (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className={`w-20 h-20 rounded-lg border-2 border-dashed flex items-center justify-center cursor-pointer transition-colors ${
                    isDark ? 'border-white/20 hover:border-white/40 text-white/30' : 'border-gray-300 hover:border-gray-400 text-gray-400'
                  }`}
                >
                  <HiOutlinePhotograph className="w-6 h-6" />
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleAddImage}
              />
            </div>
          </div>

          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/20 border border-red-500">
              <p className="text-red-500 text-sm">{error}</p>
            </div>
          )}

          <p className={`text-xs mb-4 ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
            Reports are reviewed by our team. False reports may result in action against your account.
          </p>

          <div className="flex gap-3">
            <button
              onClick={handleClose}
              className={`flex-1 px-4 py-2 rounded-full font-medium transition-all cursor-pointer ${
                isDark ? 'border border-gray-600 text-gray-300 hover:bg-gray-800' : 'border border-gray-300 text-gray-600 hover:bg-gray-50'
              }`}
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!selectedReason || isSubmitting}
              className={`flex-1 px-4 py-2 rounded-full font-medium transition-all ${
                !selectedReason || isSubmitting
                  ? 'bg-red-500/50 text-white/50 cursor-not-allowed'
                  : 'bg-red-500 text-white hover:bg-red-600 cursor-pointer'
              }`}
            >
              {isSubmitting ? 'Submitting...' : 'Submit Report'}
            </button>
          </div>
        </>
      )}
    </ModalWrapper>
  )
}

export default ReportUserModal

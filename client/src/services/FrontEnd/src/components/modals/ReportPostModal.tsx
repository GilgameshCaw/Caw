import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import { HiX, HiFlag } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'

export type ReportReason = 'SPAM' | 'HARASSMENT' | 'INAPPROPRIATE' | 'MISINFORMATION' | 'OTHER'

interface ReportPostModalProps {
  isOpen: boolean
  onClose: () => void
  postId: number
  postAuthorId: number
  postAuthorUsername?: string
  onSubmit: (reason: ReportReason, details: string) => Promise<void>
}

const REPORT_REASONS: { value: ReportReason; label: string; description: string }[] = [
  { value: 'SPAM', label: 'Spam', description: 'Unwanted commercial content or repetitive posts' },
  { value: 'HARASSMENT', label: 'Harassment', description: 'Targeted abuse, threats, or bullying' },
  { value: 'INAPPROPRIATE', label: 'Inappropriate content', description: 'Graphic, violent, or adult content' },
  { value: 'MISINFORMATION', label: 'Misinformation', description: 'False or misleading information' },
  { value: 'OTHER', label: 'Other', description: 'Another issue not listed above' }
]

const ReportPostModal: React.FC<ReportPostModalProps> = ({
  isOpen,
  onClose,
  postId,
  postAuthorId,
  postAuthorUsername,
  onSubmit
}) => {
  const { isDark } = useTheme()
  const [selectedReason, setSelectedReason] = useState<ReportReason | null>(null)
  const [details, setDetails] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isOpen) return null

  const handleSubmit = async () => {
    if (!selectedReason) return

    setIsSubmitting(true)
    setError(null)

    try {
      await onSubmit(selectedReason, details)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit report')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleClose = () => {
    setSelectedReason(null)
    setDetails('')
    setError(null)
    onClose()
  }

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/70 z-50"
        onClick={handleClose}
      />

      {/* Modal */}
      <div
        className={`fixed z-50 top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-2xl p-6 transition-all duration-300 ${
          isDark ? 'bg-gray-900 border border-yellow-500/30' : 'bg-white border border-gray-200'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-full ${isDark ? 'bg-red-500/20' : 'bg-red-50'}`}>
              <HiFlag className="w-5 h-5 text-red-500" />
            </div>
            <h3 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>
              Report Post
            </h3>
          </div>
          <button
            onClick={handleClose}
            className={`p-1 rounded-full transition-colors ${
              isDark ? 'text-white/60 hover:text-white hover:bg-white/10' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
            }`}
          >
            <HiX className="w-5 h-5" />
          </button>
        </div>

        {/* Description */}
        <p className={`text-sm mb-4 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
          {postAuthorUsername
            ? `Why are you reporting this post by @${postAuthorUsername}?`
            : 'Why are you reporting this post?'}
        </p>

        {/* Reason Selection */}
        <div className="space-y-2 mb-4">
          {REPORT_REASONS.map((reason) => (
            <button
              key={reason.value}
              onClick={() => setSelectedReason(reason.value)}
              className={`w-full text-left p-3 rounded-lg border transition-all ${
                selectedReason === reason.value
                  ? isDark
                    ? 'border-red-500 bg-red-500/10'
                    : 'border-red-500 bg-red-50'
                  : isDark
                    ? 'border-white/10 hover:border-white/20 hover:bg-white/5'
                    : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
              }`}
            >
              <div className={`font-medium ${isDark ? 'text-white' : 'text-black'}`}>
                {reason.label}
              </div>
              <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                {reason.description}
              </div>
            </button>
          ))}
        </div>

        {/* Additional Details */}
        <div className="mb-4">
          <label className={`block text-sm font-medium mb-2 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
            Additional details (optional)
          </label>
          <textarea
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            placeholder="Provide any additional context..."
            rows={3}
            className={`w-full px-3 py-2 rounded-lg border resize-none transition-colors ${
              isDark
                ? 'bg-black border-white/20 text-white placeholder-gray-500 focus:border-red-500'
                : 'bg-white border-gray-300 text-black placeholder-gray-400 focus:border-red-500'
            } focus:outline-none focus:ring-1 focus:ring-red-500`}
          />
        </div>

        {/* Error Message */}
        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/20 border border-red-500">
            <p className="text-red-500 text-sm">{error}</p>
          </div>
        )}

        {/* Info Note */}
        <p className={`text-xs mb-4 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
          Reports are reviewed by our team. False reports may result in action against your account.
          This post will also be hidden from your feed.
        </p>

        {/* Buttons */}
        <div className="flex space-x-3">
          <button
            onClick={handleClose}
            className={`flex-1 px-4 py-2 rounded-full font-medium transition-all duration-200 ${
              isDark
                ? 'border border-gray-600 text-gray-300 hover:bg-gray-800'
                : 'border border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!selectedReason || isSubmitting}
            className={`flex-1 px-4 py-2 rounded-full font-medium transition-all duration-200 ${
              !selectedReason || isSubmitting
                ? 'bg-red-500/50 text-white/50 cursor-not-allowed'
                : 'bg-red-500 text-white hover:bg-red-600'
            }`}
          >
            {isSubmitting ? 'Submitting...' : 'Submit Report'}
          </button>
        </div>
      </div>
    </>,
    document.body
  )
}

export default ReportPostModal

import React, { useState } from 'react'
import { HiFlag } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'
import { useFormSubmit } from '~/hooks/useFormSubmit'
import { themeText, themeTextMuted, themeTextSecondary } from '~/utils/theme'
import ModalWrapper from './ModalWrapper'
import ModalHeader from './ModalHeader'
import { useT } from '~/i18n/I18nProvider'

export type ReportReason = 'SPAM' | 'HARASSMENT' | 'INAPPROPRIATE' | 'EXPLICIT' | 'ILLEGAL_HARMFUL' | 'MISINFORMATION' | 'OTHER'

interface ReportPostModalProps {
  isOpen: boolean
  onClose: () => void
  postId: number
  postAuthorId: number
  postAuthorUsername?: string
  onSubmit: (reason: ReportReason, details: string) => Promise<void>
}

interface ReportReasonOption {
  value: ReportReason | 'INAPPROPRIATE_PARENT'
  label: string
  description: string
  subOptions?: { value: ReportReason; label: string; description: string }[]
}

// Reason set built inside the component so labels/descriptions resolve
// through t(). The `value` field stays as the canonical enum used by the
// API; only the rendered text changes per locale.

const ReportPostModal: React.FC<ReportPostModalProps> = ({
  isOpen,
  onClose,
  postId,
  postAuthorId,
  postAuthorUsername,
  onSubmit
}) => {
  const { isDark } = useTheme()
  const t = useT()
  const REPORT_REASONS: ReportReasonOption[] = [
    { value: 'SPAM', label: t('report.spam.label'), description: t('report.spam.description') },
    { value: 'HARASSMENT', label: t('report.harassment.label'), description: t('report.harassment.description') },
    {
      value: 'INAPPROPRIATE_PARENT',
      label: t('report.inappropriate.label'),
      description: t('report.inappropriate.description'),
      subOptions: [
        { value: 'EXPLICIT', label: t('report.explicit.label'), description: t('report.explicit.description') },
        { value: 'ILLEGAL_HARMFUL', label: t('report.illegal.label'), description: t('report.illegal.description') }
      ]
    },
    { value: 'MISINFORMATION', label: t('report.misinformation.label'), description: t('report.misinformation.description') },
    { value: 'OTHER', label: t('report.other.label'), description: t('report.other.description') }
  ]
  const [selectedReason, setSelectedReason] = useState<ReportReason | null>(null)
  const [expandedParent, setExpandedParent] = useState(false)
  const [details, setDetails] = useState('')
  const { isSubmitting, error, submitted, handleSubmit: formSubmit, reset: resetForm } = useFormSubmit()

  const handleSubmit = () => {
    if (!selectedReason) return
    formSubmit(async () => {
      try {
        await onSubmit(selectedReason, details)
      } catch {
        throw new Error(t('common.something_went_wrong'))
      }
    })
  }

  const handleClose = () => {
    setSelectedReason(null)
    setExpandedParent(false)
    setDetails('')
    resetForm()
    onClose()
  }

  return (
    <ModalWrapper
      isOpen={isOpen}
      onClose={handleClose}
      maxWidth="max-w-md"
      usePortal
      className="p-6"
    >
      {submitted ? (
        <>
          {/* Success confirmation */}
          <div className="text-center py-6">
            <div className={`w-12 h-12 rounded-full mx-auto mb-4 flex items-center justify-center ${
              isDark ? 'bg-green-500/20' : 'bg-green-50'
            }`}>
              <HiFlag className="w-6 h-6 text-green-500" />
            </div>
            <h3 className={`text-lg font-semibold mb-2 ${themeText(isDark)}`}>
              {t('report.success.title')}
            </h3>
            <p className={`text-sm ${themeTextSecondary(isDark)}`}>
              {t('report.success.body')}
            </p>
          </div>
          <button
            onClick={handleClose}
            className={`w-full px-4 py-2 rounded-full font-medium transition-all duration-200 ${
              isDark
                ? 'border border-gray-600 text-gray-300 hover:bg-gray-800'
                : 'border border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {t('report.close')}
          </button>
        </>
      ) : (
        <>
          <ModalHeader
            title={t('report.title')}
            onClose={handleClose}
            icon={<HiFlag className="w-5 h-5 text-red-500" />}
            iconBg={isDark ? 'bg-red-500/20' : 'bg-red-50'}
            border={false}
            size="lg"
            className="mb-4 px-0"
          />

          {/* Description */}
          <p className={`text-sm mb-4 ${themeTextSecondary(isDark)}`}>
            {postAuthorUsername
              ? t('report.prompt_with_user', { username: postAuthorUsername })
              : t('report.prompt')}
          </p>

          {/* Reason Selection */}
          <div className="space-y-2 mb-4">
            {REPORT_REASONS.map((reason) => {
              const isParent = reason.value === 'INAPPROPRIATE_PARENT'
              const isExpanded = isParent && expandedParent
              const isSelected = !isParent && selectedReason === reason.value
              const hasSelectedChild = isParent && reason.subOptions?.some(s => s.value === selectedReason)

              return (
                <div key={reason.value}>
                  <button
                    onClick={() => {
                      if (isParent) {
                        setExpandedParent(prev => !prev)
                        if (!hasSelectedChild) setSelectedReason(null)
                      } else if (reason.value !== 'INAPPROPRIATE_PARENT') {
                        setSelectedReason(reason.value)
                        setExpandedParent(false)
                      }
                    }}
                    className={`w-full text-left p-3 rounded-lg border transition-all ${
                      isSelected || hasSelectedChild
                        ? isDark
                          ? 'border-red-500 bg-red-500/10'
                          : 'border-red-500 bg-red-50'
                        : isExpanded
                          ? isDark
                            ? 'border-white/20 bg-white/5'
                            : 'border-gray-300 bg-gray-50'
                          : isDark
                            ? 'border-white/10 hover:border-white/20 hover:bg-white/5'
                            : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    <div className={`font-medium ${themeText(isDark)}`}>
                      {reason.label}
                    </div>
                    <div className={`text-sm ${themeTextMuted(isDark)}`}>
                      {reason.description}
                    </div>
                  </button>

                  {/* Sub-options for Inappropriate */}
                  {isExpanded && reason.subOptions && (
                    <div className="ml-4 mt-2 space-y-2">
                      {reason.subOptions.map((sub) => (
                        <button
                          key={sub.value}
                          onClick={() => setSelectedReason(sub.value)}
                          className={`w-full text-left p-3 rounded-lg border transition-all ${
                            selectedReason === sub.value
                              ? isDark
                                ? 'border-red-500 bg-red-500/10'
                                : 'border-red-500 bg-red-50'
                              : isDark
                                ? 'border-white/10 hover:border-white/20 hover:bg-white/5'
                                : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                          }`}
                        >
                          <div className={`font-medium ${themeText(isDark)}`}>
                            {sub.label}
                          </div>
                          <div className={`text-sm ${themeTextMuted(isDark)}`}>
                            {sub.description}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Additional Details */}
          <div className="mb-4">
            <label className={`block text-sm font-medium mb-2 ${themeTextSecondary(isDark)}`}>
              {t('report.details_label')}
            </label>
            <textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder={t('report.details_placeholder')}
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
          <p className={`text-xs mb-4 ${themeTextMuted(isDark)}`}>
            {t('report.disclaimer')}
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
              {t('common.cancel')}
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
              {isSubmitting ? t('report.submitting') : t('report.submit')}
            </button>
          </div>
        </>
      )}
    </ModalWrapper>
  )
}

export default ReportPostModal

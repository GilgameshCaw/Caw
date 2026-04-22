import React from 'react'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'

interface ConfirmModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  destructive?: boolean
}

const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  destructive = false,
}) => {
  const { isDark } = useTheme()

  return (
    <ModalWrapper
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="max-w-sm"
      zIndex={80}
      usePortal
      backdropClass="bg-black/60"
    >
      <div className="p-5">
        <h3 className={`text-lg font-semibold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
          {title}
        </h3>
        <p className={`text-sm mb-5 ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
          {message}
        </p>
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
              isDark
                ? 'bg-white/10 text-white hover:bg-white/20'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {cancelText}
          </button>
          <button
            onClick={() => { onConfirm(); onClose() }}
            className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
              destructive
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-yellow-500 text-black hover:bg-yellow-400'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </ModalWrapper>
  )
}

export default ConfirmModal

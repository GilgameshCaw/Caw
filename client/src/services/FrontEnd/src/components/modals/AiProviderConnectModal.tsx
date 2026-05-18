import React from 'react'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { themeText, themeTextSecondary, themeSecondaryButton } from '~/utils/theme'

interface Props {
  isOpen: boolean
  onClose: () => void
  onConnect?: () => void
}

const AiProviderConnectModal: React.FC<Props> = ({ isOpen, onClose, onConnect }) => {
  const { isDark } = useTheme()
  const t = useT()

  return (
    <ModalWrapper
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="max-w-sm"
      zIndex={90}
      usePortal
      backdropClass="bg-black/60"
    >
      <div className="p-6">
        <h2 className={`text-lg font-bold mb-2 ${themeText(isDark)}`}>
          {t('post_form.ai.modal.title')}
        </h2>
        <p className={`text-sm mb-6 ${themeTextSecondary(isDark)}`}>
          {t('post_form.ai.modal.body')}
        </p>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className={`px-4 py-2 rounded-lg text-sm transition cursor-pointer ${themeSecondaryButton(isDark)}`}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => onConnect?.()}
            className="px-4 py-2 rounded-lg text-sm font-medium transition cursor-pointer bg-yellow-500 text-black hover:bg-yellow-400"
          >
            {t('post_form.ai.modal.connect')}
          </button>
        </div>
      </div>
    </ModalWrapper>
  )
}

export default AiProviderConnectModal

import React from 'react'
import ModalWrapper from './ModalWrapper'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { useVerifyWallet } from '~/hooks/useVerifyWallet'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { themeText, themeTextSecondary, themeSecondaryButton } from '~/utils/theme'
import { useVerifyWalletStore } from '~/store/verifyWalletStore'

const VerifyWalletModal: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const { isOpen, onSuccess, close } = useVerifyWalletStore()
  const ensureWallet = useEnsureWallet()
  // Route through the shared useVerifyWallet hook (also used by
  // useDm.ts's auth path). The hook builds the canonical 4-line
  // domain-bound message (Host + ChainId, audit fix 2026-05-09 Round 7
  // CRITICAL-2). Previously the modal hand-rolled a 2-line message and
  // got "Invalid message format (missing fields)" 400s back from
  // /api/auth/verify because the server enforces all four lines.
  const { verify, isVerifying, error } = useVerifyWallet()

  const handleVerify = async () => {
    await ensureWallet(null, async () => {
      const ok = await verify()
      if (ok) {
        close()
        onSuccess?.()
      }
    })
  }

  return (
    <ModalWrapper isOpen={isOpen} onClose={close} usePortal zIndex={9999}>
      <div className="p-6">
        <h2 className={`text-lg font-bold mb-3 ${themeText(isDark)}`}>
          {t('verify_wallet.title')}
        </h2>
        <p className={`text-sm mb-6 ${themeTextSecondary(isDark)}`}>
          {t('verify_wallet.body')}
        </p>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-red-500 text-sm">
            {error}
          </div>
        )}

        <div className="flex gap-3 justify-end">
          <button
            onClick={close}
            className={`px-4 py-2 rounded-lg text-sm transition ${themeSecondaryButton(isDark)}`}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleVerify}
            disabled={isVerifying}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              isVerifying
                ? 'opacity-50 cursor-not-allowed'
                : 'hover:opacity-90'
            } bg-yellow-500 text-black`}
          >
            {isVerifying ? t('verify_wallet.btn.signing') : t('verify_wallet.btn.verify')}
          </button>
        </div>
      </div>
    </ModalWrapper>
  )
}

export default VerifyWalletModal

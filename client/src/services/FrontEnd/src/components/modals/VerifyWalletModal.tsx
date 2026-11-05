import React from 'react'
import ModalWrapper from './ModalWrapper'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { useVerifyWallet } from '~/hooks/useVerifyWallet'
import { usePasskeySignIn } from '~/hooks/usePasskeySignIn'
import { useWalletPopulation } from '~/hooks/useWalletPopulation'
import { useRecoveryContext } from '~/components/identity/RecoveryProvider'
import { useActiveToken } from '~/store/tokenDataStore'
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

  const { population } = useWalletPopulation()
  const recovery = useRecoveryContext()
  const activeToken = useActiveToken()
  const passkeySignIn = usePasskeySignIn()
  // verify() needs a personal_sign, which a passkey can't produce. A Pop-B user
  // signs in with the passkey instead, unless the recovery key is in memory.
  const isPopB = population === 'B'
  const signsWithPasskey = isPopB && !recovery.privateKey
  const busy = isVerifying || passkeySignIn.busy
  const disabled = busy || (signsWithPasskey && !activeToken?.username)

  const finish = () => {
    close()
    onSuccess?.()
  }

  const runVerify = async () => {
    if (await verify()) finish()
  }

  const handleVerify = async () => {
    if (signsWithPasskey) {
      if (!activeToken?.username) return
      try {
        await passkeySignIn.signIn(activeToken.username)
      } catch {
        return // the hook surfaces the error
      }
      finish()
      return
    }
    // Pop-B has no wagmi wallet to wait for: ensureWallet would navigate away.
    if (isPopB) {
      await runVerify()
      return
    }
    await ensureWallet(null, runVerify)
  }

  const shownError = signsWithPasskey ? passkeySignIn.error : error

  return (
    <ModalWrapper isOpen={isOpen} onClose={close} usePortal zIndex={9999}>
      <div className="p-6">
        <h2 className={`text-lg font-bold mb-3 ${themeText(isDark)}`}>
          {signsWithPasskey ? t('passkey_signin.title') : t('verify_wallet.title')}
        </h2>
        {!signsWithPasskey && (
          <p className={`text-sm mb-6 ${themeTextSecondary(isDark)}`}>
            {t('verify_wallet.body')}
          </p>
        )}

        {shownError && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-error-dim text-sm">
            {shownError}
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
            disabled={disabled}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              disabled
                ? 'opacity-50 cursor-not-allowed'
                : 'hover:opacity-90'
            } bg-yellow-500 text-black`}
          >
            {signsWithPasskey
              ? (passkeySignIn.busy ? t('passkey_signin.signing') : t('passkey_signin.cta'))
              : (isVerifying ? t('verify_wallet.btn.signing') : t('verify_wallet.btn.verify'))}
          </button>
        </div>
      </div>
    </ModalWrapper>
  )
}

export default VerifyWalletModal

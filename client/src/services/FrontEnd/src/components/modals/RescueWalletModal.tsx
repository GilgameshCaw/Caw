/**
 * RescueWalletModal — sweep CAW out of a profile-LESS passkey wallet.
 *
 * Opened from an AccountSettings "empty wallet" card. The wallet holds CAW/ETH
 * but owns no profile (its last profile was transferred away), so the normal UI
 * can't reach it. Here the user enters a destination address and sweeps the CAW
 * out; signing uses a discoverable passkey (or the recovery key), and the relay
 * fronts gas repaid in CAW from the batch. See useRescuePasskeyWallet.
 */

import { useState } from 'react'
import { isAddress, formatUnits, formatEther, type Address } from 'viem'
import ModalWrapper from './ModalWrapper'
import ModalHeader from './ModalHeader'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { themeTextSecondary, themeTextMuted, themeSecondaryButton } from '~/utils/theme'
import { useRescuePasskeyWallet } from '~/hooks/useRescuePasskeyWallet'
import type { ProfilelessWallet } from '~/hooks/useProfilelessPasskeyWallets'

export interface RescueWalletModalProps {
  wallet: ProfilelessWallet
  isOpen: boolean
  onClose: () => void
  /** Called after a successful sweep so the caller can refresh the wallet list. */
  onRescued: () => void
}

export default function RescueWalletModal({ wallet, isOpen, onClose, onRescued }: RescueWalletModalProps) {
  const { isDark } = useTheme()
  const t = useT()
  const { rescueCaw, pending } = useRescuePasskeyWallet()

  const [destination, setDestination] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const cawWhole = Number(formatUnits(wallet.cawWei, 18))

  const handleClose = () => {
    setDestination('')
    setInputError(null)
    setError(null)
    setSuccess(false)
    onClose()
  }

  const handleRescue = async () => {
    setError(null)
    setInputError(null)
    if (!isAddress(destination)) {
      setInputError(t('rescue.error.bad_address'))
      return
    }
    if (destination.toLowerCase() === wallet.address.toLowerCase()) {
      setInputError(t('rescue.error.same_address'))
      return
    }
    try {
      await rescueCaw({ walletAddress: wallet.address, destination: destination as Address })
      setSuccess(true)
      onRescued()
    } catch (err: any) {
      const raw = (err?.message || '').replace(/^API\s+\d+:\s*/i, '')
      if (/NotAllowed|abort|cancel|denied|rejected/i.test(raw)) setError(t('rescue.error.rejected'))
      else if (/NO_CAW|CAW_BELOW_FEE/i.test(raw)) setError(t('rescue.error.insufficient'))
      else if (/PRICE_UNAVAILABLE/i.test(raw)) setError(t('rescue.error.price'))
      else if (/No passkey|discoverable/i.test(raw)) setError(t('rescue.error.no_passkey'))
      else setError(t('rescue.error.failed'))
    }
  }

  return (
    <ModalWrapper isOpen={isOpen} onClose={handleClose} maxWidth="max-w-md" usePortal zIndex={9999}>
      <div className="p-6">
        <ModalHeader title={t('rescue.title')} onClose={handleClose} border={false} size="lg" className="mb-4 px-0" />

        <p className={`text-sm mb-1 ${themeTextSecondary(isDark)}`}>{t('rescue.intro')}</p>
        <p className={`text-xs mb-4 font-mono break-all ${themeTextMuted(isDark)}`}>{wallet.address}</p>

        <div className={`mb-5 p-3 rounded-lg text-sm ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
          <div className="flex justify-between">
            <span className={themeTextMuted(isDark)}>{t('rescue.caw_balance')}</span>
            <span className={isDark ? 'text-white' : 'text-gray-900'}>{cawWhole.toLocaleString(undefined, { maximumFractionDigits: 2 })} CAW</span>
          </div>
          {wallet.ethWei > 0n && (
            <div className="flex justify-between mt-1">
              <span className={themeTextMuted(isDark)}>{t('rescue.eth_balance')}</span>
              <span className={isDark ? 'text-white' : 'text-gray-900'}>{Number(formatEther(wallet.ethWei)).toFixed(5)} ETH</span>
            </div>
          )}
        </div>

        {!success && (
          <div className="mb-5">
            <label className={`block text-sm font-medium mb-2 ${themeTextSecondary(isDark)}`}>{t('rescue.dest_label')}</label>
            <input
              type="text"
              value={destination}
              onChange={e => { setDestination(e.target.value); setInputError(null) }}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              className={`w-full px-3 py-2 rounded-lg text-sm font-mono outline-none border ${
                isDark ? 'bg-white/5 border-white/10 text-white placeholder-white/30 focus:border-white/30'
                       : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:border-gray-500'
              }`}
            />
            {inputError && <p className={`mt-1 text-xs ${isDark ? 'text-red-400' : 'text-red-600'}`}>{inputError}</p>}
            <p className={`mt-2 text-[11px] ${themeTextMuted(isDark)}`}>{t('rescue.fee_note')}</p>
          </div>
        )}

        {error && (
          <div className={`mb-4 p-3 rounded-lg text-sm ${isDark ? 'bg-red-500/10 text-red-400' : 'bg-red-50 text-red-700'}`}>
            {error}
          </div>
        )}

        {success && (
          <div className={`mb-4 p-3 rounded-lg text-sm ${isDark ? 'bg-green-500/10 text-green-400' : 'bg-green-50 text-green-700'}`}>
            {t('rescue.success')}
          </div>
        )}

        <div className="flex gap-3 justify-end">
          <button
            onClick={handleClose}
            className={`px-4 py-2 rounded-lg text-sm transition cursor-pointer ${themeSecondaryButton(isDark)}`}
          >
            {success ? t('rescue.btn.close') : t('rescue.btn.cancel')}
          </button>
          {!success && (
            <button
              onClick={handleRescue}
              disabled={pending}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition cursor-pointer text-white ${
                pending ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-90'
              } bg-yellow-500 text-black`}
            >
              {pending ? t('rescue.btn.rescuing') : t('rescue.btn.rescue')}
            </button>
          )}
        </div>
      </div>
    </ModalWrapper>
  )
}

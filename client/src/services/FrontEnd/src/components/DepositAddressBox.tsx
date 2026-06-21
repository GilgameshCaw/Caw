/**
 * DepositAddressBox.tsx
 *
 * Shared address display used on both the Staking page (for all populations)
 * and inside TopUpForm (Pop-B). Shows the user's deposit address with a copy
 * button and a QR-icon that opens a QRModal.
 *
 * For Pop-B the label reads "Your deposit address / passkey-protected wallet".
 * For Pop-A it reads "Your connected wallet address".
 */

import React, { useCallback, useState } from 'react'
import type { Address } from 'viem'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import QRModal from '~/components/modals/QRModal'

interface DepositAddressBoxProps {
  address: Address | string
  /** 'B' = passkey user; anything else = Pop-A label */
  population?: string
  className?: string
}

export function DepositAddressBox({ address, population, className }: DepositAddressBoxProps) {
  const t = useT()
  const { isDark } = useTheme()
  const [copied, setCopied] = useState(false)
  const [qrOpen, setQrOpen] = useState(false)

  const isPopB = population === 'B'

  const handleCopy = useCallback(() => {
    navigator.clipboard?.writeText(address).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => { /* clipboard unavailable */ })
  }, [address])

  const strongClass = isDark ? 'text-white' : 'text-black'
  const mutedClass = isDark ? 'text-gray-400' : 'text-gray-600'
  const panelClass = `p-4 rounded-lg border transition-all duration-300 ${
    isDark ? 'bg-white/5 border-white/20' : 'bg-gray-50 border-gray-200'
  }`

  return (
    <div className={`${panelClass} ${className ?? ''}`}>
      <p className={`text-sm font-medium ${mutedClass} mb-1`}>{t('topup.address_label')}</p>
      <p className={`text-xs ${mutedClass} mb-2`}>
        {isPopB
          ? t('topup.address_explainer')
          : 'Your connected wallet address.'}
      </p>
      <p className={`font-mono text-xs break-all ${strongClass}`}>{address}</p>
      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={handleCopy}
          className={`text-xs font-medium px-3 py-1 rounded-full cursor-pointer transition-all duration-200 ${
            isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
          }`}
        >
          {copied ? t('topup.copied') : t('topup.copy_address')}
        </button>
        <button
          onClick={() => setQrOpen(true)}
          aria-label={t('topup.show_qr')}
          title={t('topup.show_qr')}
          className={`flex items-center gap-1 text-xs font-medium px-3 py-1 rounded-full cursor-pointer transition-all duration-200 ${
            isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
          }`}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" /><line x1="14" y1="14" x2="14" y2="17" />
            <line x1="17" y1="14" x2="21" y2="14" /><line x1="21" y1="17" x2="21" y2="21" /><line x1="14" y1="21" x2="17" y2="21" />
          </svg>
          {t('topup.show_qr')}
        </button>
      </div>
      <p className={`text-xs ${mutedClass} mt-3`}>{t('topup.address_hint')}</p>

      <QRModal
        isOpen={qrOpen}
        onClose={() => setQrOpen(false)}
        value={address}
        title={t('topup.address_label')}
        subtitle={isPopB ? t('topup.address_explainer') : 'Your connected wallet address.'}
        caption={address}
        downloadName="caw-deposit-address"
      />
    </div>
  )
}

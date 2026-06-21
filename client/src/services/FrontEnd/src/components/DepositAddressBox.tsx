/**
 * DepositAddressBox.tsx
 *
 * Shared address display rendered once on the Staking page (for all
 * populations) above the deposit form. Shows the user's deposit address with
 * inline copy + QR icons. Title: "Send CAW or ETH to this address". The
 * "wallet your passkey protects" reassurance line shows for Pop-B only.
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

  const iconBtnClass = `shrink-0 flex items-center justify-center w-7 h-7 rounded-full cursor-pointer transition-all duration-200 ${
    isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
  }`

  return (
    <div className={`${panelClass} ${className ?? ''}`}>
      <p className={`text-sm font-medium ${mutedClass} mb-2`}>{'Send CAW or ETH to this address'}</p>

      {/* Address + inline copy / QR icons on one line. */}
      <div className="flex items-center gap-2">
        <p className={`font-mono text-xs break-all flex-1 min-w-0 ${strongClass}`}>{address}</p>
        <button onClick={handleCopy} aria-label={t('topup.copy_address')} title={copied ? t('topup.copied') : t('topup.copy_address')} className={iconBtnClass}>
          {copied ? (
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
          ) : (
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
          )}
        </button>
        <button onClick={() => setQrOpen(true)} aria-label={t('topup.show_qr')} title={t('topup.show_qr')} className={iconBtnClass}>
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" /><line x1="14" y1="14" x2="14" y2="17" />
            <line x1="17" y1="14" x2="21" y2="14" /><line x1="21" y1="17" x2="21" y2="21" /><line x1="14" y1="21" x2="17" y2="21" />
          </svg>
        </button>
      </div>

      {/* Passkey reassurance — Pop-B only. */}
      {isPopB && (
        <p className={`text-xs ${mutedClass} mt-2`}>{t('topup.address_explainer')}</p>
      )}

      <QRModal
        isOpen={qrOpen}
        onClose={() => setQrOpen(false)}
        value={address}
        title={'Send CAW or ETH to this address'}
        subtitle={isPopB ? t('topup.address_explainer') : undefined}
        caption={address}
        downloadName="caw-deposit-address"
      />
    </div>
  )
}

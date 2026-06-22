// QRModal — the shared QR popup used wherever the app shows a scannable code
// (wallet deposit address, sponsor invite links, staking, …). Wraps
// ModalWrapper around the StyledQR renderer and adds the chrome: a
// title/caption, copy-to-clipboard, and a PNG download.
//
// The QR itself is always black-on-white for scannability (see StyledQR); the
// modal chrome follows the app's dark/light theme.

import React from 'react'
import type QRCodeStyling from 'qr-code-styling'
import ModalWrapper from '~/components/modals/ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import StyledQR from '~/components/qr/StyledQR'

export interface QRModalProps {
  isOpen: boolean
  onClose: () => void
  /** The string to encode (address, invite link, URL, …). */
  value: string
  /** Optional heading above the QR. */
  title?: string
  /** Optional sub-line under the heading (e.g. an explainer). */
  subtitle?: string
  /** Optional caption shown under the QR (e.g. the raw address/code). */
  caption?: string
  /** Filename (without extension) for the PNG download. Default 'caw-qr'. */
  downloadName?: string
  /** Modal max-width (Tailwind class or arbitrary value). Default 'max-w-xs'. */
  maxWidth?: string
}

const QR_SIZE = 208

export default function QRModal({
  isOpen,
  onClose,
  value,
  title,
  subtitle,
  caption,
  downloadName = 'caw-qr',
  maxWidth = 'max-w-xs',
}: QRModalProps) {
  const { isDark } = useTheme()
  const t = useT()
  const [copied, setCopied] = React.useState(false)
  const qrInstance = React.useRef<QRCodeStyling | null>(null)

  const handleCopy = () => {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const handleDownload = () => {
    qrInstance.current?.download({ name: downloadName, extension: 'png' })
  }

  const strong = isDark ? 'text-white' : 'text-gray-900'
  const muted = isDark ? 'text-white/60' : 'text-gray-500'
  const pill = isDark
    ? 'bg-white/10 text-white hover:bg-white/20'
    : 'bg-gray-200 text-gray-800 hover:bg-gray-300'

  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} maxWidth={maxWidth}>
      <div className="p-6 text-center">
        {title && <p className={`text-sm font-semibold mb-1 ${strong}`}>{title}</p>}
        {subtitle && <p className={`text-xs mb-4 ${muted}`}>{subtitle}</p>}

        {/* The QR — white panel keeps the quiet zone clean in dark mode too. */}
        <div className="mx-auto inline-block rounded-lg bg-white p-3">
          <StyledQR value={value} size={QR_SIZE} instanceRef={qrInstance} />
        </div>

        {caption && <p className={`font-mono text-[11px] break-all mt-4 ${muted}`}>{caption}</p>}

        {/* Copy + Download */}
        <div className="mt-4 flex items-center justify-center gap-2">
          <button type="button" onClick={handleCopy} className={`text-xs font-medium px-4 py-1.5 rounded-full cursor-pointer transition-all duration-200 ${pill}`}>
            {copied ? t('qr.copied') : t('qr.copy')}
          </button>
          <button type="button" onClick={handleDownload} className={`text-xs font-medium px-4 py-1.5 rounded-full cursor-pointer transition-all duration-200 ${pill}`}>
            {t('qr.download')}
          </button>
        </div>
      </div>
    </ModalWrapper>
  )
}

import React, { useState } from 'react'
import { HiClipboardCopy, HiCheck } from 'react-icons/hi'
import Tooltip from '~/components/Tooltip'
import { useTheme } from '~/hooks/useTheme'
import { formatAddress } from '~/utils'

interface CopyAddressButtonProps {
  address: string
  /** Render just the icon (no shortened-address text). Default false. */
  iconOnly?: boolean
  /** Override the default short-form sizing. Defaults match the Profile page (5/4). */
  shortFirst?: number
  shortLast?: number
  /** Extra classes applied to the button. */
  className?: string
}

const CopyAddressButton: React.FC<CopyAddressButtonProps> = ({
  address,
  iconOnly = false,
  shortFirst = 5,
  shortLast = 4,
  className = '',
}) => {
  const { isDark } = useTheme()
  const [copied, setCopied] = useState(false)

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // p-1.5 + larger icons give roughly a 32px square on the icon-only
  // variant — well above the 24px tap-target floor and matched to other
  // small inline action buttons on the address page. The visual icon
  // stays w-3.5 (14px) so dense pages don't feel cluttered, but the
  // padding expands the hit area for touch.
  const baseClasses = `flex items-center gap-1 text-xs font-mono cursor-pointer transition-all duration-200 p-1.5 -m-1.5 rounded ${
    isDark ? 'text-gray-500 hover:text-gray-300 hover:bg-white/5' : 'text-gray-400 hover:text-gray-600 hover:bg-black/5'
  }`

  return (
    <Tooltip text={copied ? 'Copied!' : 'Click to copy full address'}>
      <button onClick={handleClick} className={`${baseClasses} ${className}`} aria-label="Copy address">
        {!iconOnly && formatAddress(address, shortFirst, shortLast)}
        {copied
          ? <HiCheck className="w-3.5 h-3.5 text-green-500" />
          : <HiClipboardCopy className="w-3.5 h-3.5" />
        }
      </button>
    </Tooltip>
  )
}

export default CopyAddressButton

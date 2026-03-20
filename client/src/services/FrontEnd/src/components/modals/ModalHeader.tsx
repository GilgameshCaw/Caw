import React from 'react'
import { HiX } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'

interface ModalHeaderProps {
  title: string
  onClose: () => void
  /** Optional icon element to show before the title */
  icon?: React.ReactNode
  /** Icon badge background color class (e.g. 'bg-yellow-500/20', 'bg-red-500/20') */
  iconBg?: string
  /** Whether to show a bottom border (default: true) */
  border?: boolean
  /** Override border color class */
  borderClass?: string
  /** Title element tag size: 'sm' | 'md' | 'lg' (default: 'md') */
  size?: 'sm' | 'md' | 'lg'
  /** Force dark mode (skips theme check) */
  forceDark?: boolean
  /** Additional className for the container */
  className?: string
}

const ModalHeader: React.FC<ModalHeaderProps> = ({
  title,
  onClose,
  icon,
  iconBg = 'bg-yellow-500/20',
  border = true,
  borderClass,
  size = 'md',
  forceDark,
  className = '',
}) => {
  const { isDark: themeDark } = useTheme()
  const isDark = forceDark ?? themeDark

  const titleSize = size === 'lg' ? 'text-xl font-bold' : size === 'sm' ? 'text-base font-semibold' : 'text-lg font-semibold'

  const borderCls = border
    ? borderClass || `border-b ${isDark ? 'border-white/10' : 'border-gray-200'}`
    : ''

  return (
    <div className={`flex items-center justify-between px-4 py-3 ${borderCls} ${className}`}>
      <div className="flex items-center gap-3">
        {icon && (
          <div className={`p-2 rounded-full ${iconBg}`}>
            {icon}
          </div>
        )}
        <h2 className={`${titleSize} ${isDark ? 'text-white' : 'text-gray-900'}`}>
          {title}
        </h2>
      </div>
      <button
        onClick={onClose}
        className={`p-1 rounded-full transition-colors cursor-pointer ${
          isDark
            ? 'text-white/60 hover:text-white hover:bg-white/10'
            : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
        }`}
      >
        <HiX className="w-5 h-5" />
      </button>
    </div>
  )
}

export default ModalHeader

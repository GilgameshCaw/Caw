import React from 'react'
import { useTheme } from '~/hooks/useTheme'

interface TooltipProps {
  text: string
  children: React.ReactNode
  /** Position relative to the trigger element */
  position?: 'top' | 'bottom' | 'left' | 'right'
  /** Alignment of the tooltip */
  align?: 'start' | 'center' | 'end'
  /** Force dark mode styling */
  forceDark?: boolean
  /** Additional className for the wrapper */
  className?: string
}

const Tooltip: React.FC<TooltipProps> = ({
  text,
  children,
  position = 'top',
  align = 'center',
  forceDark,
  className = '',
}) => {
  const { isDark: themeDark } = useTheme()
  const isDark = forceDark ?? themeDark

  const bgClass = isDark ? 'bg-white text-black' : 'bg-gray-900 text-white'

  const positionClasses = {
    top: 'bottom-full mb-2',
    bottom: 'top-full mt-2',
    left: 'right-full mr-2',
    right: 'left-full ml-2',
  }

  const alignClasses = {
    start: position === 'top' || position === 'bottom' ? 'left-0' : 'top-0',
    center: position === 'top' || position === 'bottom'
      ? 'left-1/2 -translate-x-1/2'
      : 'top-1/2 -translate-y-1/2',
    end: position === 'top' || position === 'bottom' ? 'right-0' : 'bottom-0',
  }

  const arrowClasses = {
    top: `top-full ${align === 'start' ? 'left-3' : align === 'end' ? 'right-3' : 'left-1/2 -translate-x-1/2'} border-4 border-transparent ${isDark ? 'border-t-white' : 'border-t-gray-900'}`,
    bottom: `bottom-full ${align === 'start' ? 'left-3' : align === 'end' ? 'right-3' : 'left-1/2 -translate-x-1/2'} border-4 border-transparent ${isDark ? 'border-b-white' : 'border-b-gray-900'}`,
    left: `left-full top-1/2 -translate-y-1/2 border-4 border-transparent ${isDark ? 'border-l-white' : 'border-l-gray-900'}`,
    right: `right-full top-1/2 -translate-y-1/2 border-4 border-transparent ${isDark ? 'border-r-white' : 'border-r-gray-900'}`,
  }

  return (
    <div className={`relative group/tooltip ${className}`}>
      {children}
      <div className={`absolute ${positionClasses[position]} ${alignClasses[align]} px-3 py-2 text-xs font-medium rounded-lg whitespace-nowrap opacity-0 group-hover/tooltip:opacity-100 pointer-events-none transition-opacity duration-200 z-50 ${bgClass}`}>
        {text}
        <div className={`absolute ${arrowClasses[position]}`} />
      </div>
    </div>
  )
}

export default Tooltip

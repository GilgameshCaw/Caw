import React, { useState, useRef, useCallback, useLayoutEffect } from 'react'
import { useTheme } from '~/hooks/useTheme'

interface TooltipProps {
  text: string
  children: React.ReactNode
  /** Preferred position relative to the trigger element */
  position?: 'top' | 'bottom' | 'left' | 'right'
  /** Force dark mode styling */
  forceDark?: boolean
  /** Additional className for the wrapper */
  className?: string
}

type ResolvedPosition = 'top' | 'bottom' | 'left' | 'right'
type ResolvedAlign = 'start' | 'center' | 'end'

const Tooltip: React.FC<TooltipProps> = ({
  text,
  children,
  position = 'top',
  forceDark,
  className = '',
}) => {
  const { isDark: themeDark } = useTheme()
  const isDark = forceDark ?? themeDark

  const [visible, setVisible] = useState(false)
  const [resolvedPos, setResolvedPos] = useState<ResolvedPosition>(position)
  const [resolvedAlign, setResolvedAlign] = useState<ResolvedAlign>('center')
  const wrapperRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  const reposition = useCallback(() => {
    const wrapper = wrapperRef.current
    const tooltip = tooltipRef.current
    if (!wrapper || !tooltip) return

    const triggerRect = wrapper.getBoundingClientRect()
    const tipRect = tooltip.getBoundingClientRect()
    const pad = 8 // minimum distance from viewport edge

    let pos = position as ResolvedPosition
    let align: ResolvedAlign = 'center'

    // Check if preferred position fits, otherwise flip
    if (pos === 'top' && triggerRect.top - tipRect.height - 8 < pad) {
      pos = 'bottom'
    } else if (pos === 'bottom' && triggerRect.bottom + tipRect.height + 8 > window.innerHeight - pad) {
      pos = 'top'
    } else if (pos === 'left' && triggerRect.left - tipRect.width - 8 < pad) {
      pos = 'right'
    } else if (pos === 'right' && triggerRect.right + tipRect.width + 8 > window.innerWidth - pad) {
      pos = 'left'
    }

    // For top/bottom positioning, check horizontal overflow
    if (pos === 'top' || pos === 'bottom') {
      const tipCenterX = triggerRect.left + triggerRect.width / 2
      const halfTip = tipRect.width / 2

      if (tipCenterX - halfTip < pad) {
        // Overflows left — align start
        align = 'start'
      } else if (tipCenterX + halfTip > window.innerWidth - pad) {
        // Overflows right — align end
        align = 'end'
      }
    }

    // For left/right positioning, check vertical overflow
    if (pos === 'left' || pos === 'right') {
      const tipCenterY = triggerRect.top + triggerRect.height / 2
      const halfTip = tipRect.height / 2

      if (tipCenterY - halfTip < pad) {
        align = 'start'
      } else if (tipCenterY + halfTip > window.innerHeight - pad) {
        align = 'end'
      }
    }

    setResolvedPos(pos)
    setResolvedAlign(align)
  }, [position])

  useLayoutEffect(() => {
    if (visible) reposition()
  }, [visible, reposition])

  const handleMouseEnter = () => setVisible(true)
  const handleMouseLeave = () => setVisible(false)

  const bgClass = isDark ? 'bg-white text-black' : 'bg-gray-900 text-white'

  const positionStyles: Record<ResolvedPosition, string> = {
    top: 'bottom-full mb-2',
    bottom: 'top-full mt-2',
    left: 'right-full mr-2',
    right: 'left-full ml-2',
  }

  const alignStyles: Record<ResolvedAlign, string> = (() => {
    const isVertical = resolvedPos === 'top' || resolvedPos === 'bottom'
    return {
      start: isVertical ? 'left-0' : 'top-0',
      center: isVertical ? 'left-1/2 -translate-x-1/2' : 'top-1/2 -translate-y-1/2',
      end: isVertical ? 'right-0' : 'bottom-0',
    }
  })()

  const arrowPos = (() => {
    const alignCls = resolvedAlign === 'start' ? 'left-3' : resolvedAlign === 'end' ? 'right-3' : 'left-1/2 -translate-x-1/2'
    const vertAlignCls = resolvedAlign === 'start' ? 'top-1' : resolvedAlign === 'end' ? 'bottom-1' : 'top-1/2 -translate-y-1/2'

    switch (resolvedPos) {
      case 'top':
        return `top-full ${alignCls} border-4 border-transparent ${isDark ? 'border-t-white' : 'border-t-gray-900'}`
      case 'bottom':
        return `bottom-full ${alignCls} border-4 border-transparent ${isDark ? 'border-b-white' : 'border-b-gray-900'}`
      case 'left':
        return `left-full ${vertAlignCls} border-4 border-transparent ${isDark ? 'border-l-white' : 'border-l-gray-900'}`
      case 'right':
        return `right-full ${vertAlignCls} border-4 border-transparent ${isDark ? 'border-r-white' : 'border-r-gray-900'}`
    }
  })()

  return (
    <div
      ref={wrapperRef}
      className={`relative group/tooltip ${className}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      <div
        ref={tooltipRef}
        className={`absolute ${positionStyles[resolvedPos]} ${alignStyles[resolvedAlign]} px-3 py-2 text-xs font-medium rounded-lg whitespace-nowrap pointer-events-none transition-opacity duration-200 z-50 ${bgClass} ${visible ? 'opacity-100' : 'opacity-0'}`}
      >
        {text}
        <div className={`absolute ${arrowPos}`} />
      </div>
    </div>
  )
}

export default Tooltip

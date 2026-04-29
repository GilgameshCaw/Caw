import React, { useState, useRef, useCallback, useLayoutEffect, useEffect } from 'react'
import { createPortal } from 'react-dom'
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
  /** When true, suppress the tooltip entirely */
  disabled?: boolean
}

const Tooltip: React.FC<TooltipProps> = ({
  text,
  children,
  position = 'top',
  forceDark,
  className = '',
  disabled: tooltipDisabled,
}) => {
  const { isDark: themeDark } = useTheme()
  const isDark = forceDark ?? themeDark

  const [visible, setVisible] = useState(false)
  const [coords, setCoords] = useState({ top: 0, left: 0 })
  const wrapperRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  // Use native DOM listeners to catch hover even over disabled children.
  // Touch devices: mouseenter fires (synthesized) on tap but mouseleave
  // never does until the user taps something else *that's also mouse-aware*,
  // which leaves tooltips stuck open after a tap. Cover that with a
  // document-level pointerdown listener that hides on any tap outside the
  // trigger, plus a safety auto-hide after 4s.
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return

    let autoHideTimer: ReturnType<typeof setTimeout> | null = null

    const show = () => {
      setVisible(true)
      if (autoHideTimer) clearTimeout(autoHideTimer)
      // Auto-dismiss safety net for touch devices where the synthesized
      // mouseleave never arrives. 4s is long enough to read most tooltips.
      autoHideTimer = setTimeout(() => setVisible(false), 4000)
    }
    const hide = () => {
      setVisible(false)
      if (autoHideTimer) { clearTimeout(autoHideTimer); autoHideTimer = null }
    }
    const hideIfOutside = (e: Event) => {
      const target = e.target as Node | null
      if (!target || !el.contains(target)) hide()
    }

    el.addEventListener('mouseenter', show)
    el.addEventListener('mouseleave', hide)
    // pointerdown captures both mouse + touch — anywhere on the page that
    // isn't the trigger dismisses. Scrolling also dismisses, since on
    // mobile the absolute-positioned tooltip would otherwise float free
    // of its trigger as the page scrolls underneath.
    document.addEventListener('pointerdown', hideIfOutside)
    window.addEventListener('scroll', hide, true)

    return () => {
      el.removeEventListener('mouseenter', show)
      el.removeEventListener('mouseleave', hide)
      document.removeEventListener('pointerdown', hideIfOutside)
      window.removeEventListener('scroll', hide, true)
      if (autoHideTimer) clearTimeout(autoHideTimer)
    }
  }, [])

  const reposition = useCallback(() => {
    const wrapper = wrapperRef.current
    const tooltip = tooltipRef.current
    if (!wrapper || !tooltip) return

    const triggerRect = wrapper.getBoundingClientRect()
    const tipRect = tooltip.getBoundingClientRect()
    const pad = 8

    let top = 0
    let left = 0
    let pos = position

    if (pos === 'top' && triggerRect.top - tipRect.height - 8 < pad) pos = 'bottom'
    else if (pos === 'bottom' && triggerRect.bottom + tipRect.height + 8 > window.innerHeight - pad) pos = 'top'
    else if (pos === 'left' && triggerRect.left - tipRect.width - 8 < pad) pos = 'right'
    else if (pos === 'right' && triggerRect.right + tipRect.width + 8 > window.innerWidth - pad) pos = 'left'

    if (pos === 'top') {
      top = triggerRect.top - tipRect.height - 8
      left = triggerRect.left + triggerRect.width / 2 - tipRect.width / 2
    } else if (pos === 'bottom') {
      top = triggerRect.bottom + 8
      left = triggerRect.left + triggerRect.width / 2 - tipRect.width / 2
    } else if (pos === 'left') {
      top = triggerRect.top + triggerRect.height / 2 - tipRect.height / 2
      left = triggerRect.left - tipRect.width - 8
    } else {
      top = triggerRect.top + triggerRect.height / 2 - tipRect.height / 2
      left = triggerRect.right + 8
    }

    left = Math.max(pad, Math.min(left, window.innerWidth - pad - tipRect.width))
    top = Math.max(pad, Math.min(top, window.innerHeight - pad - tipRect.height))

    setCoords({ top, left })
  }, [position])

  useLayoutEffect(() => {
    if (visible) reposition()
  }, [visible, reposition])

  const bgClass = isDark ? 'bg-white text-black' : 'bg-gray-900 text-white'

  return (
    <div
      ref={wrapperRef}
      className={`relative inline-block ${className}`}
    >
      {children}
      {visible && !tooltipDisabled && createPortal(
        <div
          ref={tooltipRef}
          className={`fixed px-3 py-2 text-xs font-medium text-center rounded-lg whitespace-nowrap pointer-events-none z-[9999] ${bgClass}`}
          style={{ top: coords.top, left: coords.left }}
        >
          {text.split('\n').map((line, i, arr) => (
            <React.Fragment key={i}>
              {line}
              {i < arr.length - 1 && <br />}
            </React.Fragment>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}

export default Tooltip

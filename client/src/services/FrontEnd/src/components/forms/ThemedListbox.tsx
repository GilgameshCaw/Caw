import React, { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Listbox, Transition } from '@headlessui/react'
import { themeBorder, themeInput, themeTextMuted } from '~/utils/theme'

export type ThemedListboxOption<T extends string | number> = {
  value: T
  label: string
}

type Props<T extends string | number> = {
  isDark: boolean
  value: T
  onChange: (value: T) => void
  options: ThemedListboxOption<T>[]
  disabled?: boolean
  className?: string
  /** Visual size. md matches Settings dropdowns; sm for compact rows (e.g. poll composer). */
  size?: 'md' | 'sm'
  /** Portal the options panel to <body> to avoid clipping by overflow-hidden/auto ancestors. */
  portal?: boolean
}

export default function ThemedListbox<T extends string | number>({
  isDark,
  value,
  onChange,
  options,
  disabled = false,
  className = '',
  size = 'md',
  portal = false,
}: Props<T>) {
  const selected = useMemo(() => options.find(o => o.value === value), [options, value])
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [portalStyle, setPortalStyle] = useState<React.CSSProperties | null>(null)

  const buttonSize = size === 'sm'
    ? 'h-[30px] px-2 rounded-lg text-xs'
    : 'h-[52px] px-3 rounded-lg text-sm'
  const optionSize = size === 'sm'
    ? 'px-2 py-1.5 rounded-lg text-xs'
    : 'px-3 py-2 rounded-lg text-sm'

  // Fixed height to align with inputs across browsers/fonts (md). sm is for tight inline rows.
  const buttonClass = `w-full ${buttonSize} outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0 transition cursor-pointer flex items-center justify-between ${themeInput(isDark)}`

  const panelBaseClass = `rounded-xl border shadow-lg overflow-hidden ${
    isDark ? 'bg-neutral-900' : 'bg-white'
  } ${themeBorder(isDark)}`
  const inlinePanelClass = `absolute mt-1 w-full z-[60] ${panelBaseClass}`
  // When portaled, we're outside any modal stacking context; ensure we're above z-50 dialogs.
  const portalPanelClass = `fixed z-[200] ${panelBaseClass}`

  const recomputePortalStyle = useCallback(() => {
    if (!portal) return
    const btn = buttonRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()

    const gap = 6
    const maxH = 240 // tailwind max-h-60
    const viewportH = window.innerHeight
    const viewportW = window.innerWidth

    const spaceBelow = viewportH - r.bottom
    const willOpenAbove = spaceBelow < Math.min(maxH, 140)

    const width = Math.max(120, Math.min(r.width, viewportW - 16))
    const left = Math.min(Math.max(8, r.left), viewportW - 8 - width)

    const top = willOpenAbove
      ? Math.max(8, r.top - gap)
      : Math.min(viewportH - 8, r.bottom + gap)

    setPortalStyle({
      left,
      top,
      width,
      transform: willOpenAbove ? 'translateY(-100%)' : undefined,
    })
  }, [portal])

  // Keep the portaled panel aligned on resize/scroll while open.
  useEffect(() => {
    if (!portal) return
    if (!isOpen) return
    const onWin = () => recomputePortalStyle()
    window.addEventListener('resize', onWin)
    // capture=true so we also catch scrolls on nested scroll containers
    window.addEventListener('scroll', onWin, { capture: true, passive: true })
    return () => {
      window.removeEventListener('resize', onWin)
      window.removeEventListener('scroll', onWin, { capture: true } as EventListenerOptions)
    }
  }, [portal, isOpen, recomputePortalStyle])

  // When opening, measure after Options mounts (next paint).
  useLayoutEffect(() => {
    if (!portal) return
    if (!isOpen) return
    recomputePortalStyle()
  }, [portal, isOpen, recomputePortalStyle])

  return (
    <Listbox value={value} onChange={onChange} disabled={disabled}>
      <div className={`relative ${className}`}>
        <Listbox.Button
          ref={buttonRef}
          className={buttonClass}
          onPointerDown={() => {
            if (!portal) return
            // Precompute so the first paint of the portaled panel lands in the right place.
            // The real open/close state is inferred from Options mount/unmount.
            recomputePortalStyle()
          }}
        >
          <span className="truncate">{selected?.label ?? 'Select'}</span>
          <svg className={`h-4 w-4 flex-shrink-0 ${themeTextMuted(isDark)}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </Listbox.Button>

        {portal
          ? createPortal(
            <Transition as={Fragment} leave="transition ease-in duration-100" leaveFrom="opacity-100" leaveTo="opacity-0">
              <Listbox.Options
                ref={(node) => {
                  const openNow = !!node
                  setIsOpen(openNow)
                  if (!openNow) setPortalStyle(null)
                }}
                className={portalPanelClass}
                style={portalStyle ?? undefined}
              >
              <div className="max-h-60 overflow-auto p-1">
                {options.map(opt => (
                   <Listbox.Option key={String(opt.value)} value={opt.value}>
                     {({ active, selected }) => (
                       <div
                         className={`${optionSize} cursor-pointer select-none flex items-center justify-between gap-2 ${
                           selected
                             ? isDark
                               ? 'bg-yellow-500/20 text-yellow-200'
                               : 'bg-yellow-100 text-yellow-800'
                             : ''
                        } ${
                          active && !selected
                            ? isDark
                              ? 'bg-white/10 text-white'
                              : 'bg-gray-100 text-gray-900'
                            : ''
                        } ${!active && !selected ? (isDark ? 'text-white' : 'text-gray-900') : ''}`}
                      >
                        <span className="truncate">{opt.label}</span>
                        {selected && (
                          <svg className={`h-4 w-4 flex-shrink-0 ${isDark ? 'text-yellow-300' : 'text-yellow-700'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                    )}
                  </Listbox.Option>
                ))}
              </div>
              </Listbox.Options>
            </Transition>,
            document.body,
          )
          : (
            <Transition as={Fragment} leave="transition ease-in duration-100" leaveFrom="opacity-100" leaveTo="opacity-0">
              <Listbox.Options className={inlinePanelClass}>
                <div className="max-h-60 overflow-auto p-1">
                  {options.map(opt => (
                    <Listbox.Option key={String(opt.value)} value={opt.value}>
                      {({ active, selected }) => (
                        <div
                          className={`${optionSize} cursor-pointer select-none flex items-center justify-between gap-2 ${
                            selected
                              ? isDark
                                ? 'bg-yellow-500/20 text-yellow-200'
                                : 'bg-yellow-100 text-yellow-800'
                              : ''
                         } ${
                           active && !selected
                             ? isDark
                               ? 'bg-white/10 text-white'
                               : 'bg-gray-100 text-gray-900'
                             : ''
                         } ${!active && !selected ? (isDark ? 'text-white' : 'text-gray-900') : ''}`}
                        >
                          <span className="truncate">{opt.label}</span>
                          {selected && (
                            <svg className={`h-4 w-4 flex-shrink-0 ${isDark ? 'text-yellow-300' : 'text-yellow-700'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                      )}
                    </Listbox.Option>
                  ))}
                </div>
              </Listbox.Options>
            </Transition>
          )}
      </div>
    </Listbox>
  )
}

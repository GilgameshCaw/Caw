import React, { useEffect, useMemo, useRef, useState } from 'react'
import { HiChevronLeft, HiChevronRight } from 'react-icons/hi'
import ThemedListbox from '~/components/forms/ThemedListbox'

const pad2 = (n: number) => String(n).padStart(2, '0')
const isValidDate = (d: Date) => !Number.isNaN(d.getTime())

const panelClass = (isDark: boolean) =>
  `absolute mt-2 rounded-xl border shadow-lg z-[70] overflow-visible ${
    isDark ? 'bg-neutral-900 border-white/10' : 'bg-white border-gray-200'
  }`

const fieldClass = (isDark: boolean) =>
  `w-full px-3 py-2 rounded-lg border transition-colors outline-none flex items-center justify-between gap-3 ${
    isDark
      ? 'bg-black border-white/20 text-white'
      : 'bg-white border-gray-300 text-gray-900'
  }`

const subtleText = (isDark: boolean) => (isDark ? 'text-white/50' : 'text-gray-400')
const hoverBg = (isDark: boolean) => (isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100')

export function DesktopDatePicker({
  isDark,
  value,
  open,
  onOpenChange,
  onChange,
}: {
  isDark: boolean
  value: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (next: string) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)

  const selected = useMemo(() => {
    if (!value) return null
    const d = new Date(`${value}T00:00:00`)
    return isValidDate(d) ? d : null
  }, [value])

  const [cursor, setCursor] = useState<Date>(() => selected ?? new Date())

  useEffect(() => {
    if (selected) setCursor(new Date(selected.getFullYear(), selected.getMonth(), 1))
  }, [selected])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (!t || !rootRef.current?.contains(t)) onOpenChange(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onOpenChange])

  const display = selected
    ? selected.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
    : ''

  const year = cursor.getFullYear()
  const month = cursor.getMonth()
  const first = new Date(year, month, 1)
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  // Monday-first index.
  const startIndex = (first.getDay() + 6) % 7
  const prevMonthDays = new Date(year, month, 0).getDate()

  const cells = Array.from({ length: 42 }, (_, i) => {
    const dayNum = i - startIndex + 1
    if (dayNum < 1) {
      const d = prevMonthDays + dayNum
      const dt = new Date(year, month - 1, d)
      return { dt, inMonth: false }
    }
    if (dayNum > daysInMonth) {
      const d = dayNum - daysInMonth
      const dt = new Date(year, month + 1, d)
      return { dt, inMonth: false }
    }
    return { dt: new Date(year, month, dayNum), inMonth: true }
  })

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

  const today = useMemo(() => {
    const t = new Date()
    t.setHours(0, 0, 0, 0)
    return t
  }, [])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className={`${fieldClass(isDark)} ${hoverBg(isDark)} cursor-pointer`}
        onClick={() => onOpenChange(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className={display ? '' : subtleText(isDark)}>{display || 'dd/mm/aaaa'}</span>
        <span className={subtleText(isDark)}>
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </span>
      </button>

      {open && (
        <div className={`${panelClass(isDark)} left-0 w-[280px] p-3`} role="dialog">
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              className={`p-1 rounded-md ${hoverBg(isDark)} ${subtleText(isDark)}`}
              onClick={() => setCursor(new Date(year, month - 1, 1))}
              aria-label="Previous month"
            >
              <HiChevronLeft className="w-5 h-5" />
            </button>
            <div className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {cursor.toLocaleString(undefined, { month: 'long', year: 'numeric' })}
            </div>
            <button
              type="button"
              className={`p-1 rounded-md ${hoverBg(isDark)} ${subtleText(isDark)}`}
              onClick={() => setCursor(new Date(year, month + 1, 1))}
              aria-label="Next month"
            >
              <HiChevronRight className="w-5 h-5" />
            </button>
          </div>

          <div className={`grid grid-cols-7 gap-1 text-[11px] mb-1 ${subtleText(isDark)}`}>
            {['LU', 'MA', 'MI', 'JU', 'VI', 'SA', 'DO'].map(d => (
              <div key={d} className="text-center py-1">{d}</div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {cells.map(({ dt, inMonth }, idx) => {
              const selectedDay = selected ? isSameDay(dt, selected) : false
              const disabled = dt.getTime() < today.getTime()
              const cls = selectedDay
                ? (isDark ? 'bg-yellow-500/20 text-yellow-200' : 'bg-yellow-100 text-yellow-800')
                : inMonth
                  ? (isDark ? 'text-white hover:bg-white/10' : 'text-gray-900 hover:bg-gray-100')
                  : (isDark ? 'text-white/35 hover:bg-white/5' : 'text-gray-400 hover:bg-gray-50')
              return (
                <button
                  key={idx}
                  type="button"
                  disabled={disabled}
                  className={`h-9 rounded-md text-sm transition-colors ${cls} ${disabled ? 'opacity-30 cursor-not-allowed hover:bg-transparent' : ''}`}
                  onClick={() => {
                    if (disabled) return
                    const next = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`
                    onChange(next)
                    onOpenChange(false)
                  }}
                >
                  {dt.getDate()}
                </button>
              )
            })}
          </div>

          <div className="flex items-center justify-between mt-3">
            <button
              type="button"
              className={`text-xs font-medium px-2 py-1 rounded-md ${hoverBg(isDark)} ${isDark ? 'text-white/70' : 'text-gray-600'}`}
              onClick={() => {
                onChange('')
                onOpenChange(false)
              }}
            >
              Borrar
            </button>
            <button
              type="button"
              className={`text-xs font-medium px-2 py-1 rounded-md ${hoverBg(isDark)} ${isDark ? 'text-yellow-200' : 'text-yellow-800'}`}
              onClick={() => {
                const now = new Date()
                const next = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
                onChange(next)
                onOpenChange(false)
              }}
            >
              Hoy
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function DesktopTimePicker({
  isDark,
  value,
  open,
  onOpenChange,
  onChange,
}: {
  isDark: boolean
  value: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (next: string) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (!t || !rootRef.current?.contains(t)) onOpenChange(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onOpenChange])

  const [h, m] = (value || '').split(':')
  const selH = h && h.length === 2 ? h : ''
  const selM = m && m.length === 2 ? m : ''

  const hours = useMemo(() => Array.from({ length: 24 }, (_, i) => pad2(i)), [])
  const minutes = useMemo(() => Array.from({ length: 60 }, (_, i) => pad2(i)), [])

  const display = value || ''

  const setPart = (nextH: string, nextM: string) => {
    if (!nextH || !nextM) return
    onChange(`${nextH}:${nextM}`)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className={`${fieldClass(isDark)} ${hoverBg(isDark)} cursor-pointer`}
        onClick={() => onOpenChange(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className={display ? '' : subtleText(isDark)}>{display || '--:--'}</span>
        <span className={subtleText(isDark)}>
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </span>
      </button>

      {open && (
        <div className={`${panelClass(isDark)} right-0 w-[320px] p-3`} role="dialog">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className={`text-xs mb-1 ${subtleText(isDark)}`}>Hour</div>
              <ThemedListbox
                isDark={isDark}
                value={(selH || '00')}
                onChange={(hr) => setPart(String(hr), selM || '00')}
                options={hours.map(v => ({ value: v, label: v }))}
              />
            </div>
            <div>
              <div className={`text-xs mb-1 ${subtleText(isDark)}`}>Minute</div>
              <ThemedListbox
                isDark={isDark}
                value={(selM || '00')}
                onChange={(mi) => setPart(selH || '00', String(mi))}
                options={minutes.map(v => ({ value: v, label: v }))}
              />
            </div>
          </div>

          <div className="flex items-center justify-between mt-3 px-1">
            <button
              type="button"
              className={`text-xs font-medium px-2 py-1 rounded-md ${hoverBg(isDark)} ${isDark ? 'text-white/70' : 'text-gray-600'}`}
              onClick={() => {
                onChange('')
                onOpenChange(false)
              }}
            >
              Borrar
            </button>
            <button
              type="button"
              className={`text-xs font-medium px-2 py-1 rounded-md ${hoverBg(isDark)} ${isDark ? 'text-yellow-200' : 'text-yellow-800'}`}
              onClick={() => onOpenChange(false)}
            >
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

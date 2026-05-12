import React, { Fragment, useMemo } from 'react'
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
}

export default function ThemedListbox<T extends string | number>({
  isDark,
  value,
  onChange,
  options,
  disabled = false,
  className = '',
}: Props<T>) {
  const selected = useMemo(() => options.find(o => o.value === value), [options, value])

  // Fixed height to align with inputs across browsers/fonts
  const buttonClass = `w-full h-[52px] px-3 rounded-lg text-sm outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0 transition cursor-pointer flex items-center justify-between ${themeInput(isDark)}`
  const panelClass = `absolute mt-1 w-full rounded-xl border shadow-lg z-[60] overflow-hidden ${
    isDark ? 'bg-neutral-900' : 'bg-white'
  } ${themeBorder(isDark)}`

  return (
    <Listbox value={value} onChange={onChange} disabled={disabled}>
      <div className={`relative ${className}`}>
        <Listbox.Button className={buttonClass}>
          <span className="truncate">{selected?.label ?? 'Select'}</span>
          <svg className={`h-4 w-4 flex-shrink-0 ${themeTextMuted(isDark)}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </Listbox.Button>

        <Transition as={Fragment} leave="transition ease-in duration-100" leaveFrom="opacity-100" leaveTo="opacity-0">
          <Listbox.Options className={panelClass}>
            <div className="max-h-60 overflow-auto p-1">
              {options.map(opt => (
                <Listbox.Option key={String(opt.value)} value={opt.value}>
                  {({ active, selected }) => (
                    <div
                      className={`px-3 py-2 rounded-lg text-sm cursor-pointer select-none flex items-center justify-between gap-2 ${
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
      </div>
    </Listbox>
  )
}

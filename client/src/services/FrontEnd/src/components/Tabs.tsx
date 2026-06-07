// src/components/Tabs.tsx
import React from 'react'
import { useTheme } from '~/hooks/useTheme'

export interface TabItem<T extends string> {
  id:    T
  label: string
  /** Optional count badge. Rendered as " (count)" suffix on sm+ screens
   * only — hidden below sm so long translations don't blow out the row.
   * Pass the already-formatted string (e.g. "1.2K") since you control the
   * formatter. Empty string / undefined hides the suffix entirely. */
  count?: string
}

type Props<T extends string> = {
  tabs:   TabItem<T>[]
  active: T
  onChange: (tab: T) => void
  /** Render the bottom divider line under the tab row. */
  showDivider?: boolean
  /**
   * Layout density.
   *   'default' — equal-width tabs centered across the row, generous
   *               padding and text-lg labels. The right call for short,
   *               low-count tab sets like Home (For You / Following) or
   *               Explore.
   *   'compact' — text-base, tighter padding, sm+ tabs distribute via
   *               justify-between with overflow-x-auto as a safety net.
   *               Use when labels can grow long under translation
   *               (e.g. Profile's Publicaciones / Respuestas / Medios /
   *               Me gusta) and would otherwise clip or wrap.
   * Default is 'default' so existing callers stay untouched.
   */
  density?: 'default' | 'compact'
}

export function Tabs<T extends string>({ tabs, active, onChange, density = 'default', showDivider = true }: Props<T>) {
  const { isDark } = useTheme()

  const containerClasses = density === 'compact'
    ? 'flex w-full justify-stretch sm:justify-between transition-all duration-300 overflow-x-auto thin-scrollbar'
    : 'flex w-full justify-center sm:justify-center transition-all duration-300'

  const buttonLayoutClasses = density === 'compact'
    ? 'py-3 px-1.5 sm:px-2.5 flex-1 sm:flex-initial text-center font-medium text-base'
    : 'py-4 px-2 sm:px-8 flex-1 text-center font-medium text-lg'

  return (
    <div className={`${containerClasses} ${
      showDivider ? (isDark ? 'border-b border-white/20' : 'border-b border-gray-300') : ''
    }`}>
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`${buttonLayoutClasses} transition-all duration-200 cursor-pointer whitespace-nowrap ${
            t.id === active
              ? `${isDark
                  ? 'text-white border-yellow-500'
                  : 'text-black border-yellow-500'
                } border-b-2`
              : `${isDark
                  ? 'text-gray-400 hover:text-white hover:bg-white/5'
                  : 'text-gray-600 hover:text-black hover:bg-gray-100'
                }`
          }`}
        >
          {t.label}
          {t.count && <span className="hidden sm:inline"> ({t.count})</span>}
        </button>
      ))}
    </div>
  )
}

export default Tabs

// src/components/Tabs.tsx
import React from 'react'
import { useTheme } from '~/hooks/useTheme'

export interface TabItem<T extends string> {
  id:    T
  label: string
}

type Props<T extends string> = {
  tabs:   TabItem<T>[]
  active: T
  onChange: (tab: T) => void
}

export function Tabs<T extends string>({ tabs, active, onChange }: Props<T>) {
  const { isDark } = useTheme()
  
  return (
    <div className={`flex justify-center sm:justify-center border-b transition-all duration-300 ${
      isDark ? 'border-white/20' : 'border-gray-300'
    }`}>
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`py-4 px-2 sm:px-8 sm:flex-1 text-center font-medium text-lg transition-all duration-200 cursor-pointer whitespace-nowrap ${
            t.id === active
              ? `${isDark 
                  ? 'text-white border-white' 
                  : 'text-black border-black'
                } border-b-2`
              : `${isDark 
                  ? 'text-gray-400 hover:text-white hover:bg-white/5' 
                  : 'text-gray-600 hover:text-black hover:bg-gray-100'
                }`
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

export default Tabs

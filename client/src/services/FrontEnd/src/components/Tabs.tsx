// src/components/Tabs.tsx
import React from 'react'

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
  return (
    <div className="flex space-x-4 border-b border-gray-700">
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={
            `py-2 flex-1 text-center ` +
            (t.id === active
              ? 'border-b-2 border-blue-500 text-white'
              : 'text-gray-400')
          }
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

export default Tabs

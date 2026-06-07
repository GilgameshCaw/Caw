import React, { useState } from 'react'

const MALE_RANGE = { start: 1, end: 100 }
const FEMALE_RANGE = { start: 101, end: 131 }
const PER_PAGE = 20

type Tab = 'male' | 'female'

interface AvatarPickerProps {
  currentId: number
  isDark: boolean
  onAccept: (id: number) => void
  onBack: () => void
}

const AvatarPicker: React.FC<AvatarPickerProps> = ({ currentId, isDark, onAccept, onBack }) => {
  const initialTab: Tab = currentId > MALE_RANGE.end ? 'female' : 'male'
  const [tab, setTab] = useState<Tab>(initialTab)
  const [selectedId, setSelectedId] = useState(currentId)
  const [page, setPage] = useState(() => {
    const range = initialTab === 'female' ? FEMALE_RANGE : MALE_RANGE
    return Math.floor((currentId - range.start) / PER_PAGE)
  })

  const range = tab === 'female' ? FEMALE_RANGE : MALE_RANGE
  const total = range.end - range.start + 1
  const totalPages = Math.ceil(total / PER_PAGE)
  const start = range.start + page * PER_PAGE
  const end = Math.min(start + PER_PAGE - 1, range.end)

  const avatarIds: number[] = []
  for (let i = start; i <= end; i++) avatarIds.push(i)

  const switchTab = (t: Tab) => {
    setTab(t)
    setPage(0)
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between mb-8">
        <button
          type="button"
          onClick={onBack}
          className={`text-sm font-medium cursor-pointer ${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-black'}`}
        >
          &larr; Back
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => switchTab('male')}
            className={`px-4 py-1.5 rounded-full text-sm font-medium cursor-pointer transition-colors ${
              tab === 'male'
                ? 'bg-yellow-500 text-black'
                : isDark ? 'text-gray-400 hover:bg-white/10' : 'text-gray-500 hover:bg-black/5'
            }`}
          >
            Male
          </button>
          <button
            type="button"
            onClick={() => switchTab('female')}
            className={`px-4 py-1.5 rounded-full text-sm font-medium cursor-pointer transition-colors ${
              tab === 'female'
                ? 'bg-yellow-500 text-black'
                : isDark ? 'text-gray-400 hover:bg-white/10' : 'text-gray-500 hover:bg-black/5'
            }`}
          >
            Female
          </button>
        </div>
        <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          {page + 1} / {totalPages}
        </span>
      </div>

      <div className="grid grid-cols-5 gap-5 justify-items-center">
        {avatarIds.map(id => (
          <button
            key={id}
            type="button"
            onClick={() => setSelectedId(id)}
            className={`w-14 h-14 rounded-full overflow-hidden border-2 cursor-pointer transition-all duration-150 ${
              selectedId === id
                ? 'border-yellow-500 ring-2 ring-yellow-500/40 scale-110'
                : isDark
                  ? 'border-transparent hover:border-gray-500'
                  : 'border-transparent hover:border-gray-400'
            }`}
          >
            <img
              src={`/images/avatars/${id}.png`}
              alt={`Avatar ${id}`}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between mt-8">
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage(p => p - 1)}
            className={`px-3 py-1 rounded-full text-sm font-medium cursor-pointer transition-colors ${
              page === 0
                ? 'opacity-30 cursor-not-allowed'
                : isDark ? 'text-gray-300 hover:bg-white/10' : 'text-gray-600 hover:bg-black/5'
            }`}
          >
            &lsaquo; Prev
          </button>
          <button
            type="button"
            disabled={page >= totalPages - 1}
            onClick={() => setPage(p => p + 1)}
            className={`px-3 py-1 rounded-full text-sm font-medium cursor-pointer transition-colors ${
              page >= totalPages - 1
                ? 'opacity-30 cursor-not-allowed'
                : isDark ? 'text-gray-300 hover:bg-white/10' : 'text-gray-600 hover:bg-black/5'
            }`}
          >
            Next &rsaquo;
          </button>
        </div>
        <button
          type="button"
          onClick={() => onAccept(selectedId)}
          className="px-6 py-2 rounded-full font-medium bg-yellow-500 hover:bg-yellow-600 text-black cursor-pointer"
        >
          Accept
        </button>
      </div>
    </div>
  )
}

export default AvatarPicker

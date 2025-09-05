import React from 'react'
import { HiSearch } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'

const SearchBar: React.FC = () => {
  const { isDark } = useTheme()
  
  return (
    <div className="relative mt-0">
      <div className="relative">
        <HiSearch className={`absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 transition-all duration-300 ${
          isDark ? 'text-white/70' : 'text-gray-600'
        }`} />
        <input
          type="text"
          placeholder="Search"
          className={`w-full rounded-full py-3 pl-12 pr-4 transition-all duration-300 focus:outline-none ${
            isDark 
              ? 'bg-black border-white/20 text-white placeholder-white/50 focus:border-white/30 focus:bg-black' 
              : 'bg-gray-100 border-gray-300 text-black placeholder-gray-500 focus:border-gray-400 focus:bg-gray-200'
          } border`}
        />
      </div>
    </div>
  )
}

export default SearchBar

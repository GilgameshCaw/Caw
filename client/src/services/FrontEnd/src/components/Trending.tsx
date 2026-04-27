import React from 'react'
import { Link } from 'react-router-dom'
import TrendingHashtags from './TrendingHashtags'
import { useTheme } from '~/hooks/useTheme'

const Trending: React.FC = () => {
  const { isDark, toggle } = useTheme()

  return (
    <>
      <div className={`rounded-xl p-6 border mx-4 my-2 transition-all duration-300 ${
        isDark
          ? 'bg-black border-yellow-500/30'
          : 'bg-white border-gray-200'
      }`}>
        <h2 className={`text-xl font-bold mb-6 transition-all duration-300 ${
          isDark ? 'text-white' : 'text-black'
        }`}>Trending</h2>
        <TrendingHashtags />
      </div>

      {/* Footer buttons - outside container */}
      <div className="px-8 mt-4 mb-2">
        <div className="flex justify-between text-sm">
          <Link
            to="/help/faq"
            className={`transition-colors duration-200 hover:underline cursor-pointer ${
              isDark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-black'
            }`}
          >
            FAQ
          </Link>
          <span className={`${
            isDark ? 'text-gray-600' : 'text-gray-400'
          }`}>-</span>
          <Link
            to="/help/resources"
            className={`transition-colors duration-200 hover:underline cursor-pointer ${
              isDark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-black'
            }`}
          >
            Resources
          </Link>
          <span className={`${
            isDark ? 'text-gray-600' : 'text-gray-400'
          }`}>-</span>
          <Link
            to="/help/manifesto"
            className={`transition-colors duration-200 hover:underline cursor-pointer ${
              isDark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-black'
            }`}
          >
            Manifesto
          </Link>
          <span className={`${isDark ? 'text-gray-600' : 'text-gray-400'}`}>-</span>
          <button
            onClick={toggle}
            className={`transition-colors duration-200 cursor-pointer ${
              isDark ? 'text-gray-400 hover:text-yellow-400' : 'text-gray-500 hover:text-yellow-500'
            }`}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDark ? (
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="5" />
                <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
              </svg>
            ) : (
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </>
  )
}

export default Trending

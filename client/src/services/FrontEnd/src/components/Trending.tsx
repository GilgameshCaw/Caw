import React from 'react'
import { Link } from 'react-router-dom'
import TrendingHashtags from './TrendingHashtags'
import { useTheme } from '~/hooks/useTheme'

const Trending: React.FC = () => {
  const { isDark, toggle } = useTheme()

  return (
    <>
      <div className={`rounded-xl p-6 shadow-xl border mx-4 my-2 transition-all duration-300 ${
        isDark
          ? 'bg-black border-yellow-500/30'
          : 'bg-gray-100 border-gray-200'
      }`}>
        <h2 className={`text-xl font-bold mb-6 transition-all duration-300 ${
          isDark ? 'text-white' : 'text-black'
        }`}>Trending</h2>
        <TrendingHashtags />
      </div>

      {/* Footer buttons - outside container */}
      <div className="px-8 mt-4 mb-2">
        <div className="flex justify-between text-sm">
          <a
            href="https://caw.is"
            target="_blank"
            rel="noopener noreferrer"
            className={`transition-colors duration-200 hover:underline cursor-pointer ${
              isDark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-black'
            }`}
          >
            Caw.is
          </a>
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
            to="/help/faq"
            className={`transition-colors duration-200 hover:underline cursor-pointer ${
              isDark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-black'
            }`}
          >
            FAQ
          </Link>
          <span className={`${isDark ? 'text-gray-600' : 'text-gray-400'}`}>-</span>
          <button
            onClick={toggle}
            className={`transition-colors duration-200 cursor-pointer ${
              isDark ? 'text-gray-400 hover:text-yellow-400' : 'text-gray-500 hover:text-yellow-500'
            }`}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDark ? '\u2600\uFE0F' : '\uD83C\uDF19'}
          </button>
        </div>
      </div>
    </>
  )
}

export default Trending
import React from 'react'
import { Link } from 'react-router-dom'
import TrendingHashtags from './TrendingHashtags'
import { useTheme } from '~/hooks/useTheme'

const Trending: React.FC = () => {
  const { isDark } = useTheme()

  return (
    <>
      <div className={`rounded-xl p-6 shadow-xl border mx-4 my-2 transition-all duration-300 ${
        isDark
          ? 'bg-white/5 border-white/10'
          : 'bg-gray-100 border-gray-200'
      }`}>
        <h2 className={`text-xl font-bold mb-6 transition-all duration-300 ${
          isDark ? 'text-white' : 'text-black'
        }`}>Trending</h2>
        <TrendingHashtags />
      </div>

      {/* Footer buttons - outside container */}
      <div className="ml-8 mr-4 mt-4 mb-2">
        <div className="flex flex-wrap gap-4 text-sm">
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
        </div>
      </div>
    </>
  )
}

export default Trending
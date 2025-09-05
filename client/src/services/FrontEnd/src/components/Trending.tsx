import React from 'react'
import { useTheme } from '~/hooks/useTheme'

const Trending: React.FC = () => {
  const { isDark } = useTheme()
  
  const trends = [
    '#CawProtocol',
    '#Gilgamesh',
    '#TehFutureIsHere',
    '#IAmRyoshi',
    '#DecentralizedFreedom',
    '#Cawmmunity',
    '#OneWhoStillDreams'
  ]

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
        <div className="space-y-4">
          {trends.map(t => (
            <div
              key={t}
              className={`cursor-pointer p-3 rounded-lg transition-colors duration-200 group ${
                isDark 
                  ? 'hover:bg-white/10' 
                  : 'hover:bg-gray-200/50'
              }`}
            >
              <span className={`font-medium transition-colors duration-200 ${
                isDark 
                  ? 'text-gray-300 group-hover:text-white' 
                  : 'text-gray-600 group-hover:text-black'
              }`}>
                {t}
              </span>
            </div>
          ))}
        </div>
      </div>
      
      {/* Footer buttons - outside container */}
      <div className="ml-8 mr-4 mt-4 mb-2">
        <div className="flex flex-wrap gap-4 text-sm">
          <button className={`transition-colors duration-200 hover:underline cursor-pointer ${
            isDark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-black'
          }`}>
            Caw.is
          </button>
          <span className={`${
            isDark ? 'text-gray-600' : 'text-gray-400'
          }`}>-</span>
          <button className={`transition-colors duration-200 hover:underline cursor-pointer ${
            isDark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-black'
          }`}>
            Terms
          </button>
          <span className={`${
            isDark ? 'text-gray-600' : 'text-gray-400'
          }`}>-</span>
          <button className={`transition-colors duration-200 hover:underline cursor-pointer ${
            isDark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-black'
          }`}>
            Help
          </button>
        </div>
      </div>
    </>
  )
}

export default Trending


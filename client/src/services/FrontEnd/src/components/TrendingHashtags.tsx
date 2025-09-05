import React from 'react'
import { useTheme } from '~/hooks/useTheme'

const TrendingHashtags: React.FC = () => {
  const { isDark } = useTheme()
  
  const trendingHashtags = [
    { tag: 'CawProtocol', posts: '2.3K', trend: 'up' },
    { tag: 'Gilgamesh', posts: '1.8K', trend: 'up' },
    { tag: 'TehFutureIsHere', posts: '1.5K', trend: 'up' },
    { tag: 'IAmRyoshi', posts: '1.2K', trend: 'up' },
    { tag: 'DecentralizedFreedom', posts: '980', trend: 'up' },
    { tag: 'Cawmmunity', posts: '756', trend: 'up' },
    { tag: 'OneWhoStillDreams', posts: '432', trend: 'up' }
  ]

  return (
    <div className="space-y-4">
      {trendingHashtags.map((item, index) => (
        <div
          key={item.tag}
          className={`cursor-pointer p-3 rounded-lg transition-colors duration-200 group ${
            isDark 
              ? 'hover:bg-white/10' 
              : 'hover:bg-gray-200/50'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <span className={`text-sm font-medium transition-colors duration-200 ${
                isDark 
                  ? 'text-gray-300 group-hover:text-white' 
                  : 'text-gray-600 group-hover:text-black'
              }`}>
                #{index + 1}
              </span>
              <span className={`font-medium transition-colors duration-200 ${
                isDark 
                  ? 'text-gray-300 group-hover:text-white' 
                  : 'text-gray-600 group-hover:text-black'
              }`}>
                #{item.tag}
              </span>
            </div>
            <div className="flex items-center space-x-2">
              <span className={`text-xs transition-colors duration-200 ${
                isDark 
                  ? 'text-gray-400 group-hover:text-gray-300' 
                  : 'text-gray-500 group-hover:text-gray-600'
              }`}>
                {item.posts} posts
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export default TrendingHashtags
